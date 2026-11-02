import { agentCommand, type AgentKind, type LaunchProfile } from "@corral/protocol/config";
import type {
  AgentStatus,
  CreateTerminalInput,
  Session,
  SessionKind,
  SessionView,
  Task,
  TaskAgent,
  TerminalInfo,
  TerminalSize,
} from "@corral/protocol/rpc";
import { normalizeLabel } from "@corral/protocol/label";
import type { StatusReport } from "@corral/protocol/status-report";
import { AGENTS } from "../agents/agents.ts";
import { codexRemoteArgs } from "../agents/codex.ts";
import { codexChatSupport } from "../agents/codex-version.ts";
import { openCodeServerArgs } from "../agents/opencode.ts";
import type { ChatService } from "../chat/chat-service.ts";
import { ChatLaunchError, type ChatSubject } from "../chat/chat-errors.ts";
import type { CodexServers } from "../chat/codex-server.ts";
import type { OpenCodeServers } from "../chat/opencode-server.ts";
import {
  codexHome,
  watchForCodexSession,
  type CodexSessionWatch,
} from "../agents/codex-sessions.ts";
import { isExecutable } from "../agents/executable-lookup.ts";
import { resolveEnvRefs } from "../agents/launch-env.ts";
import { ChangeFeed } from "../changes/change-feed.ts";
import type { ConfigWatcher } from "../config/config-watcher.ts";
import { newId } from "../storage/ids.ts";
import { TaskNotFoundError } from "../tasks/errors.ts";
import { SerialQueue } from "../tasks/serial-queue.ts";
import type { TaskStore } from "../tasks/task-store.ts";
import { sameStatus, statusAfterExit, statusFromReport } from "../status/agent-status.ts";
import type { OpenCodeIntegration } from "../status/opencode-integration.ts";
import { newStatusToken, tokensEqual } from "../status/status-token.ts";
import type { TerminalRegistry } from "../terminals/terminal-registry.ts";
import {
  AgentDisabledError,
  AgentNotFoundError,
  AlreadyRunningError,
  LaunchProfileChangedError,
  LaunchProfileRevisionWithoutProfileError,
  LaunchProfileUnknownError,
  LaunchSpawnError,
  LaunchViewUnsupportedError,
  SessionNotFoundError,
  ShellPromptError,
} from "./errors.ts";
import { launchDiagnostic, launchFailureReason, redactLaunchError } from "./launch-diagnostics.ts";
import { launchSnapshotFor } from "./launch-snapshot.ts";
import type { SessionStore, StoredSession } from "./session-store.ts";

/** Sessions started with no client to size them yet: a restored one, or a task's primary session. */
const UNATTACHED_SIZE: TerminalSize = { cols: 80, rows: 24 };

/**
 * What a removed session tells the task it leaves behind. The database clears
 * `tasks.primary_session_id` through its foreign key, so the tasks feed has to republish the row;
 * nothing else about the task changes.
 */
export interface SessionTasks {
  primarySessionRemoved(): void;
}

/** What `start` and `startPrimary` let the caller choose; the launch snapshot is made from it. */
export interface SessionStartChoice {
  profileId?: string | undefined;
  expectedProfileRevision?: string | undefined;
  model?: string | undefined;
  /** What the agent starts working on; the first launch is the only one that gets it. */
  prompt?: string | undefined;
  /** `terminal` when omitted; `chat` needs an agent with a chat driver. */
  view?: SessionView | undefined;
}

/**
 * What a session runs in: a terminal, or for a chat session the RPC child and its chat timeline;
 * the search for the Codex id while there is none yet; and the token this launch reports status
 * with.
 */
interface Live {
  /** The terminal of a `terminal` session; null while a chat session is the live frontend. */
  terminalId: string | null;
  /** Whether the live frontend is a chat child rather than a terminal. */
  chat: boolean;
  discovery: CodexSessionWatch | undefined;
  /** The terminal leg's launch token: its OSC reports and the HTTP status report carry it. */
  statusToken: string;
  /**
   * The chat leg's launch token. It is separate on purpose: a both-live session has two frontends,
   * and opening the terminal must not rotate the identity the live chat driver reports with.
   */
  chatStatusToken: string;
  /** Once this launch has had an HTTP report accepted, its OSC 7501 reports no longer change the status. */
  reportedOverHttp: boolean;
  /** A terminal leg that fell back to OpenCode's own private server because the shared one could not start. */
  standaloneOpenCode: boolean;
  /**
   * A Codex terminal leg that runs plain `codex` (its own managed daemon) because the tested
   * app-server is not available: an untested CLI version, or a server that would not start.
   * Chat refuses such a session for this run, because a second app-server would be a second
   * writer on the same thread.
   */
  standaloneCodex: boolean;
  /** Why chat is refused for a standalone Codex leg; visible as the refusal's sentence. */
  codexChatReason: string | undefined;
}

export type StatusReportOutcome = "accepted" | "unknown-session" | "forbidden";

/**
 * A chat launch's frontend is started by the same resume decision as its terminal leg: one
 * computation in `#launch`, passed to `#launchChat` as a boolean. The rule itself is the terminal
 * leg's — `AgentAdapter.hasConversation`, because Claude writes no transcript before its first
 * prompt and an SDK `resume` of an id without one fails instead of starting the task.
 */

export class SessionService {
  readonly #store: SessionStore;
  readonly #tasks: TaskStore;
  readonly #terminals: TerminalRegistry;
  readonly #chat: ChatService;
  readonly #live = new Map<string, Live>();
  readonly #statusUrl: (sessionId: string) => string;
  readonly #openCode: OpenCodeIntegration;
  /** The one `opencode serve` of this Corral run; both legs of an OpenCode session are its clients. */
  readonly #openCodeServers: OpenCodeServers;
  /** One `codex app-server` per Codex session; both of that session's legs are its clients. */
  readonly #codexServers: CodexServers;
  readonly #config: Pick<ConfigWatcher, "state">;
  readonly #taskEvents: SessionTasks;
  // Kept after the process is gone: a `done` or `error` outlives it. Not persisted.
  readonly #statuses = new Map<string, AgentStatus>();
  // Why the last launch failed; visible to clients that connect after a restore. Not persisted.
  readonly #launchErrors = new Map<string, string>();
  readonly #changes = new ChangeFeed();
  // Starting, stopping and removing wait for processes; one at a time keeps a session's steps in order.
  readonly #queue = new SerialQueue();
  #shuttingDown = false;

  constructor(options: {
    store: SessionStore;
    tasks: TaskStore;
    terminals: TerminalRegistry;
    /** The chat frontends; a `view: "chat"` session launches here instead of a PTY. */
    chat: ChatService;
    /** Where an agent of this session POSTs its status; resolved at launch, when the server is listening. */
    statusUrl: (sessionId: string) => string;
    openCode: OpenCodeIntegration;
    /** The shared OpenCode server of this run; started lazily, stopped with its last client. */
    openCodeServers: OpenCodeServers;
    /** The per-session Codex app-servers; started lazily, stopped with each session's last client. */
    codexServers: CodexServers;
    /** The current config, for the profile a new session names. Never read on resume. */
    config: Pick<ConfigWatcher, "state">;
    /** Told when a removal took a task's primary session away, so the task feed republishes it. */
    taskEvents: SessionTasks;
  }) {
    this.#store = options.store;
    this.#tasks = options.tasks;
    this.#taskEvents = options.taskEvents;
    this.#terminals = options.terminals;
    this.#chat = options.chat;
    this.#statusUrl = options.statusUrl;
    this.#openCode = options.openCode;
    this.#openCodeServers = options.openCodeServers;
    this.#codexServers = options.codexServers;
    this.#config = options.config;
  }

  list(): Session[] {
    return this.#store.list().map((stored) => this.#withTerminal(stored));
  }

  watch(signal: AbortSignal | undefined): AsyncGenerator<Session[]> {
    return this.#changes.watch(() => this.list(), signal);
  }

  start(
    taskId: string,
    kind: SessionKind,
    size: TerminalSize,
    choice: SessionStartChoice = {},
  ): Promise<Session> {
    return this.#queue.run(() => this.#start(taskId, kind, size, choice, false));
  }

  /**
   * Starts the agent session a task was created with, before any client is attached. Unlike
   * `start`, a launch that fails keeps the session: it stays `stopped` with its launch error, so the
   * task keeps what the user made and can start it again (design.md, **Domain model → Task →
   * Creation**). Nothing here throws for the launch itself; the caller keeps the task either way.
   */
  startPrimary(taskId: string, agent: TaskAgent, prompt: string | null): Promise<Session> {
    return this.#queue.run(() =>
      this.#start(
        taskId,
        agent.kind,
        UNATTACHED_SIZE,
        {
          profileId: agent.profileId,
          expectedProfileRevision: agent.expectedProfileRevision,
          model: agent.model,
          prompt: prompt ?? undefined,
          view: agent.view,
        },
        true,
      ),
    );
  }

  async #start(
    taskId: string,
    kind: SessionKind,
    size: TerminalSize,
    choice: SessionStartChoice,
    keepFailedLaunch: boolean,
  ): Promise<Session> {
    const task = this.#task(taskId);
    const view = this.#viewFor(kind, choice.view);
    const stored: StoredSession = {
      id: newId(),
      taskId,
      kind,
      view,
      agentSessionId: kind === "shell" ? null : AGENTS[kind].newSessionId(),
      state: "running",
      label: null,
      createdAt: Date.now(),
      launch: null,
    };
    try {
      // A disabled agent is not offered anywhere; a new launch of it is refused rather than run
      // behind the pickers' back. An existing session can still be stopped and resumed. Inside
      // the try, so a task created with one keeps its stopped session like any failed launch.
      if (kind !== "shell" && !this.#agentEnabled(kind)) throw new AgentDisabledError(kind);
      stored.launch = this.#launchSnapshot(kind, choice);
      const prompt = this.#promptFor(kind, choice.prompt);
      await this.#launch(stored, task, size, "start", prompt);
    } catch (error) {
      if (!keepFailedLaunch) throw error;
      const reason = launchFailureReason(error);
      const failed: StoredSession = { ...stored, state: "stopped" };
      this.#store.insert(failed);
      this.#launchErrors.set(failed.id, reason);
      this.#changes.notify();
      console.error(
        `corral-server: could not start the primary session of task ${taskId} (${kind}): ${reason}`,
        launchDiagnostic(error),
      );
      return this.#withTerminal(failed);
    }
    this.#store.insert(stored);
    this.#changes.notify();
    return this.#withTerminal(stored);
  }

  /** The launch choices as they are stored on the session; resolves the profile the caller named. */
  #launchSnapshot(kind: SessionKind, choice: SessionStartChoice) {
    const profile = choice.profileId === undefined ? undefined : this.#profile(choice.profileId);
    if (choice.expectedProfileRevision !== undefined) {
      if (profile === undefined) throw new LaunchProfileRevisionWithoutProfileError();
      if (profile.revision !== choice.expectedProfileRevision)
        throw new LaunchProfileChangedError(profile.id);
    }
    return launchSnapshotFor({ kind, profile, modelOverride: choice.model });
  }

  /**
   * Starts a stopped session again. `prompt` is used only when the agent has no conversation to
   * resume and starts one instead — Claude Code that failed before writing its transcript — so the
   * caller decides whether to hand it over again; a real resume drops it. The task's primary
   * session gets its task's prompt again by itself: that is the work the task was made for, and
   * only a start that never reached the agent gets it.
   */
  restart(
    id: string,
    size: TerminalSize,
    choice: { prompt?: string | undefined } = {},
  ): Promise<Session> {
    return this.#queue.run(async () => {
      const stored = this.#stored(id);
      if (stored.state === "running") throw new AlreadyRunningError(id);
      const prompt = this.#promptFor(stored.kind, choice.prompt ?? this.#taskPrompt(stored));
      // The exited terminal of a session that stopped by itself stays listed until now; a chat
      // session is stopped before anything new spawns, so one session never has two writers.
      const previous = this.#live.get(id);
      // Read before the launch: the live record is one object per session, and the launch replaces
      // its terminal id in place.
      const exitedTerminal = previous?.terminalId ?? null;
      if (previous?.chat) {
        await this.#chat.stop(id);
        await this.#openCodeServers.release(openCodeOwner("chat", id));
        await this.#codexServers.release(codexOwner("chat", id), id);
      }
      try {
        await this.#launch(stored, this.#task(stored.taskId), size, "resume", prompt);
      } catch (error) {
        const reason = launchFailureReason(error);
        this.#launchErrors.set(id, reason);
        this.#changes.notify();
        console.error(
          `corral-server: could not restart session ${stored.id} (${stored.kind}): ${reason}`,
          launchDiagnostic(error),
        );
        throw error;
      }
      if (exitedTerminal !== null) await this.#terminals.close(exitedTerminal);
      this.#store.setState(id, "running");
      this.#store.setResumeOnUnsettle(id, false);
      this.#changes.notify();
      return this.#withTerminal({ ...stored, state: "running" });
    });
  }

  /**
   * Hands the session over between its two views (design.md, decision 5): the live frontend is
   * stopped through the same path a stop uses — a chat child closes stdin and is waited for, then
   * killed with its group; a terminal's PTY is closed and awaited — and only then does the other
   * view start on the same agent session id. One frontend exists at any moment, and the session
   * keeps its id, label and place in the task's tabs because nothing recreates the row.
   *
   * A working turn is aborted first, so the chat's own transcript settles before the process goes.
   * The conversation is the agent's, so history survives the frontend; in-flight output and pending
   * requests do not, which is what the confirmation in the client says. A handoff whose second
   * start fails leaves the session `stopped` (and settled, so a dead session does not keep its task
   * in "working") in the target view with the launch error, so `restart` (or `setView` back) is the
   * retry; a stopped session only records the view its next start opens in.
   *
   * Asking for the view the session already has touches nothing: two windows on one session, or a
   * second `prefix v` before the first one's answer arrives, would otherwise kill and respawn a
   * perfectly good frontend.
   */
  setView(id: string, view: SessionView, size: TerminalSize): Promise<Session> {
    return this.#queue.run(async () => {
      const stored = this.#stored(id);
      const target = this.#viewFor(stored.kind, view);
      if (stored.view === target) return this.#withTerminal(stored);
      if (stored.state === "running" && this.#bothLive(stored.kind)) {
        // This agent's two frontends are clients of one server (`design.md`, **Terminal and
        // chat**), so opening the other view starts a client beside the live one instead of
        // stopping what the user is looking at. The session keeps one tab; the stored view says
        // which frontend the main area shows, and the other stays live server-side.
        const live = this.#live.get(id);
        const attached = target === "chat" ? (live?.chat ?? false) : this.#terminalAlive(id);
        if (!attached) {
          try {
            await this.#launch(
              { ...stored, view: target },
              this.#task(stored.taskId),
              size,
              "resume",
              this.#taskPrompt(stored) ?? null,
            );
          } catch (error) {
            const reason = launchFailureReason(error);
            this.#launchErrors.set(id, reason);
            console.error(
              `corral-server: could not open the ${target} view of session ${stored.id} (${stored.kind}): ${reason}`,
              launchDiagnostic(error),
            );
            throw error;
          }
        }
        this.#store.setView(id, target);
        this.#changes.notify();
        return this.#withTerminal(this.#stored(id));
      }
      if (stored.state === "running") {
        const prompt = this.#taskPrompt(stored) ?? null;
        await this.#chat.abortWorking(id);
        await this.#halt(id);
        try {
          await this.#launch(
            { ...stored, view: target },
            this.#task(stored.taskId),
            size,
            "resume",
            prompt,
          );
        } catch (error) {
          const reason = launchFailureReason(error);
          this.#store.setView(id, target);
          this.#launchErrors.set(id, reason);
          // The second frontend never started, so what the first one reported no longer holds:
          // a `working` status on a stopped session would keep its task in "Working" forever.
          this.#settle(id);
          this.#changes.notify();
          console.error(
            `corral-server: could not hand session ${stored.id} over to ${target} (${stored.kind}): ${reason}`,
            launchDiagnostic(error),
          );
          throw error;
        }
      }
      this.#store.setView(id, target);
      this.#changes.notify();
      return this.#withTerminal(this.#stored(id));
    });
  }

  stop(id: string): Promise<Session> {
    return this.#queue.run(async () => {
      const stored = this.#stored(id);
      await this.#halt(id);
      if (stored.state === "running") this.#settle(id);
      this.#changes.notify();
      return this.#withTerminal(this.#stored(id));
    });
  }

  remove(id: string): Promise<void> {
    return this.#queue.run(async () => {
      const stored = this.#stored(id);
      // Read before the delete: the foreign key takes the reference away with the row.
      const wasPrimary = this.#tasks.get(stored.taskId)?.primarySessionId === id;
      await this.#halt(id);
      this.#store.delete(id);
      this.#statuses.delete(id);
      this.#launchErrors.delete(id);
      this.#chat.forget(id);
      this.#changes.notify();
      if (wasPrimary) this.#taskEvents.primarySessionRemoved();
    });
  }

  /**
   * Names the session for the user; a blank label takes the name away again. Only the stored
   * name changes, so the process, the agent conversation and the terminal stay as they are.
   */
  setLabel(id: string, label: string | null): Session {
    this.#stored(id);
    this.#store.setLabel(id, normalizeLabel(label));
    this.#changes.notify();
    return this.#withTerminal(this.#stored(id));
  }

  /**
   * What the chat procedures need to know about a session, or undefined for an unknown id. The
   * chat drivers stay in `chat/`; this is the session facts they are keyed by.
   */
  chatSubject(id: string): ChatSubject | undefined {
    const stored = this.#store.get(id);
    return stored === undefined
      ? undefined
      : { sessionId: stored.id, kind: stored.kind, view: stored.view, state: stored.state };
  }

  /** An agent's HTTP status report. Only the launch that got the token can report, and only while its process runs. */
  reportStatus(id: string, token: string, report: StatusReport): StatusReportOutcome {
    if (!this.#store.get(id)) return "unknown-session";
    const live = this.#live.get(id);
    const running =
      live !== undefined &&
      live.terminalId !== null &&
      this.#terminals.get(live.terminalId)?.info.exit === null;
    if (!live || !running || !tokensEqual(live.statusToken, token)) return "forbidden";
    live.reportedOverHttp = true;
    this.#setStatus(id, statusFromReport(report, Date.now()));
    return "accepted";
  }

  /** Closing a session's terminal stops the session; any other terminal is just closed. False when the id is unknown. */
  async closeTerminal(terminalId: string): Promise<boolean> {
    const sessionId = this.#terminals.get(terminalId)?.info.sessionId;
    if (sessionId) {
      try {
        await this.stop(sessionId);
        return true;
      } catch (error) {
        if (!(error instanceof SessionNotFoundError)) throw error;
      }
    }
    return this.#terminals.close(terminalId);
  }

  hasRunningIn(taskIds: ReadonlySet<string>): boolean {
    return this.#store
      .list()
      .some((stored) => taskIds.has(stored.taskId) && stored.state === "running");
  }

  removeAllIn(taskIds: ReadonlySet<string>): Promise<void> {
    return this.#queue.run(async () => {
      const doomed = this.#store.list().filter((stored) => taskIds.has(stored.taskId));
      for (const stored of doomed) {
        // oxlint-disable-next-line no-await-in-loop -- processes are stopped one after the other
        await this.#halt(stored.id);
        this.#store.delete(stored.id);
        this.#statuses.delete(stored.id);
        this.#launchErrors.delete(stored.id);
        this.#chat.forget(stored.id);
      }
      if (doomed.length > 0) this.#changes.notify();
    });
  }

  /**
   * Stops the running sessions of a task that is being settled and remembers them, so that
   * `resumeAllIn` starts them again.
   */
  suspendAllIn(taskId: string): Promise<void> {
    return this.#queue.run(async () => {
      const running = this.#store
        .list()
        .filter((stored) => stored.taskId === taskId && stored.state === "running");
      for (const stored of running) {
        // oxlint-disable-next-line no-await-in-loop -- processes are stopped one after the other
        await this.#halt(stored.id);
        this.#settle(stored.id);
        this.#store.setResumeOnUnsettle(stored.id, true);
      }
      if (running.length > 0) this.#changes.notify();
    });
  }

  /** Starts the sessions `suspendAllIn` remembered, with the launch rules of a server restart. */
  resumeAllIn(taskId: string): Promise<void> {
    return this.#queue.run(async () => {
      const remembered = this.#store.listResumableOnUnsettle(taskId);
      for (const stored of remembered) {
        this.#store.setResumeOnUnsettle(stored.id, false);
        // Awaited on purpose: the queue is what keeps a launch from racing a stop or a restart.
        // oxlint-disable-next-line no-await-in-loop -- sessions are relaunched one after the other
        if (stored.state !== "running") await this.#relaunch(stored);
      }
      if (remembered.length > 0) this.#changes.notify();
    });
  }

  /**
   * Starts again every session that was running when the server last went down: a shell fresh,
   * an agent resumed. One that cannot start becomes `stopped`; nothing here may keep the server
   * from starting. The sessions of a settled task stay stopped and are remembered for when the
   * task is active again.
   */
  restore(): void {
    for (const stored of this.#store.list()) {
      if (stored.state !== "running") continue;
      if (this.#tasks.get(stored.taskId)?.state === "settled") {
        this.#settle(stored.id);
        this.#store.setResumeOnUnsettle(stored.id, true);
      } else {
        // Through the queue, like every other session mutation: a restore that spawned beside a
        // queued stop or restart could leave two frontends, or resurrect a session the user stopped.
        void this.#queue.run(() => this.#relaunch(stored));
      }
    }
  }

  /** Called before the terminals are closed: what the sessions were doing is kept for the next start. */
  async shutDown(): Promise<void> {
    await this.#queue.run(async () => undefined);
    this.#shuttingDown = true;
    // Closing stdin is pi's orderly shutdown; a child that outlives the server is killed with its
    // group, so no chat frontend keeps writing a session file after this server is gone.
    await this.#chat.closeAll();
    await Promise.all(
      [...this.#live.values()].flatMap((live) => (live.discovery ? [live.discovery.finish()] : [])),
    );
    // Its clients are gone; nothing of this run may keep the server on the data directory.
    await this.#openCodeServers.closeAll();
    await this.#codexServers.closeAll();
  }

  #stored(id: string): StoredSession {
    const stored = this.#store.get(id);
    if (!stored) throw new SessionNotFoundError(id);
    return stored;
  }

  #task(id: string): Task {
    const task = this.#tasks.get(id);
    if (!task) throw new TaskNotFoundError(id);
    return task;
  }

  #withTerminal(stored: StoredSession): Session {
    return {
      ...stored,
      terminalId: this.#live.get(stored.id)?.terminalId ?? null,
      status: this.#statuses.get(stored.id) ?? null,
      launchError: this.#launchErrors.get(stored.id) ?? null,
    };
  }

  #profile(id: string): LaunchProfile {
    const profile = this.#config.state().profiles.find((candidate) => candidate.id === id);
    if (!profile) throw new LaunchProfileUnknownError(id);
    return profile;
  }

  /** The prompt of the task whose primary session this is, if it is one (design.md, **Sessions**). */
  #taskPrompt(stored: StoredSession): string | undefined {
    const task = this.#tasks.get(stored.taskId);
    // Only an agent becomes primary, so a prompt never lands on a shell here.
    return task?.primarySessionId === stored.id ? (task.prompt ?? undefined) : undefined;
  }

  /**
   * The prompt a caller asked for, or `null`. A shell runs no agent, so it takes none: dropping
   * one silently would lose the user's words without a trace.
   */
  #promptFor(kind: SessionKind, prompt: string | undefined): string | null {
    if (prompt === undefined || prompt.trim() === "") return null;
    if (kind === "shell") throw new ShellPromptError();
    return prompt;
  }

  /** Whether this build can run the agent as chat at all; task creation asks before applying a view. */
  hasChatDriver(kind: SessionKind): boolean {
    return this.#chat.hasDriver(kind);
  }

  /** The executable a launch of `kind` runs: `[agents.<kind>].command`, else the agent's name. */
  #agentCommand(kind: SessionKind): string {
    if (kind === "shell") throw new Error("a shell has no agent command");
    return agentCommand(this.#config.state().config, kind);
  }

  #agentEnabled(kind: AgentKind): boolean {
    return this.#config.state().config.agents[kind].enabled.value;
  }

  /** Whether this agent's chat driver declares both views live at once (C1's OpenCode). */
  #bothLive(kind: SessionKind): boolean {
    if (kind === "shell") return false;
    return this.#chat
      .capabilities()
      .some((each) => each.kind === kind && each.terminalView === "both-live");
  }

  /**
   * One leg's registration as a client of this session's Codex app-server. Both legs name the same
   * session, so the terminal and the chat driver share one process and one writer (`codex-server.ts`).
   */
  #codexServer(
    leg: "chat" | "terminal",
    stored: StoredSession,
    task: Task,
    command: string,
    env: Record<string, string>,
  ): Promise<{ socketPath: string }> {
    return this.#codexServers.acquire(codexOwner(leg, stored.id), {
      sessionId: stored.id,
      command,
      cwd: task.workspacePath,
      env,
      onExit: (reason) => {
        if (this.#shuttingDown) return;
        // Only a crash gets here (an expected stop is silent, `codex-server.ts`). The TUI keeps
        // "Reconnecting to server…" forever (measured, `.e2e/stage-c/c3/probe/`), so a session
        // whose app-server is gone has no frontend worth keeping: the terminal leg is closed, and
        // its recorded exit settles the session through the same path a stop uses.
        this.#launchErrors.set(stored.id, reason);
        this.#changes.notify();
        void this.#queue.run(async () => {
          const live = this.#live.get(stored.id);
          if (live === undefined) return;
          if (live.terminalId !== null) {
            await this.#terminals.close(live.terminalId);
            // A closed terminal records no exit (`TerminalSession` skips `#recordExit` once it is
            // closed), so the session is settled here rather than through `whenExitRecorded`.
            live.terminalId = null;
          }
          await this.#codexServers.release(codexOwner("terminal", stored.id), stored.id);
          if (!live.chat) {
            await live.discovery?.finish();
            live.discovery = undefined;
            this.#live.delete(stored.id);
            this.#settle(stored.id);
          }
          this.#changes.notify();
        });
      },
    });
  }

  /** One leg's registration as a client of the shared OpenCode server of this run. */
  #openCodeServer(
    leg: "chat" | "terminal",
    stored: StoredSession,
    task: Task,
    command: string,
    env: Record<string, string>,
  ): Promise<{ url: string; password: string }> {
    return this.#openCodeServers.acquire(openCodeOwner(leg, stored.id), {
      command,
      cwd: task.workspacePath,
      env,
    });
  }

  /** The view a start runs in; a chat view needs an agent with a chat driver in this build. */
  #viewFor(kind: SessionKind, view: SessionView | undefined): SessionView {
    const resolved = view ?? "terminal";
    if (resolved === "chat" && !this.#chat.hasDriver(kind))
      throw new LaunchViewUnsupportedError(kind, resolved);
    return resolved;
  }

  /**
   * The effective environment of one launch: the server's own, the profile's resolved references,
   * and the server-owned `CORRAL_*` variables, which win over references. A missing reference fails
   * here, before anything is spawned.
   */
  #launchEnv(stored: StoredSession): { env: Record<string, string>; referencedValues: string[] } {
    const env = stringEnv({ ...process.env });
    let referencedValues: string[] = [];
    if (stored.launch !== null) {
      const resolved = resolveEnvRefs(
        stored.launch.env,
        process.env,
        stored.launch.profile?.id ?? null,
      );
      referencedValues = Object.values(resolved);
      Object.assign(env, resolved);
    }
    env["CORRAL_SESSION_ID"] = stored.id;
    env["CORRAL_TASK_ID"] = stored.taskId;
    return { env, referencedValues };
  }

  /**
   * Starts the session's frontend in the view it was created with; throws, changing nothing, when
   * it cannot. A terminal gets a PTY; a chat session gets its agent in RPC mode, whose live state is
   * the chat timeline and whose only writer is that child.
   *
   * `prompt` is a candidate initial prompt, used only when the launch starts a conversation: the
   * first start, or a start under the same id that falls back here because the conversation was
   * never written (Claude Code that failed before its transcript, pi with no user message yet). A
   * resume of an existing conversation drops it, or the agent would redo the work. Nothing stores
   * the prompt text, so whether to pass it again after such a fallback is the caller's decision.
   */
  async #launch(
    stored: StoredSession,
    task: Task,
    size: TerminalSize,
    how: "start" | "resume",
    prompt: string | null = null,
  ): Promise<void> {
    const adapter = stored.kind === "shell" ? undefined : AGENTS[stored.kind];
    const statusToken = newStatusToken();
    const { env, referencedValues } = this.#launchEnv(stored);
    // One resume decision for both legs: how the frontend opens the conversation, decided by the
    // agent adapter (`AgentAdapter.hasConversation`). The chat leg cannot disagree with the
    // terminal leg, and a revert to the raw `how` is caught by the service test.
    const recordedConversationId = stored.agentSessionId;
    const liveBefore = this.#live.get(stored.id);
    // The app-server is the authority while it is live: a chat leg's thread, or a terminal client
    // that has not written its first turn yet, is in that process's memory even when no rollout
    // file exists. Only a session that has to start a new server asks the disk, so a both-live
    // switch never opens a second conversation beside the live one.
    const codexServerLive =
      stored.kind === "codex" &&
      (liveBefore?.chat === true || this.#codexServers.socketOf(stored.id) !== undefined);
    const resumable =
      adapter !== undefined &&
      how === "resume" &&
      recordedConversationId !== null &&
      (codexServerLive || (adapter.hasConversation?.(recordedConversationId, env) ?? true));
    if (stored.view === "chat") {
      // A chat view is only created for an agent with a driver, and a shell never has one.
      if (stored.kind === "shell") throw new LaunchViewUnsupportedError(stored.kind, stored.view);
      await this.#launchChat(
        stored,
        stored.kind,
        task,
        env,
        statusToken,
        resumable,
        prompt,
        referencedValues,
      );
      return;
    }
    const input: CreateTerminalInput = { cwd: task.workspacePath, size };
    const previous = liveBefore;
    let standalone = previous?.standaloneOpenCode ?? false;
    let standaloneCodex = false;
    let codexChatReason: string | undefined;
    // The conversation this terminal leg opens: the recorded one when it can be resumed, else none
    // (a new one, whose id Codex assigns and the launch then looks for).
    let conversationId: string | null = null;
    if (adapter) {
      // A chat frontend of this session may still hold pi's session file (a server that died, a
      // child that outlived its kill): the record is what stops it, and a terminal launch writes
      // the same file. Released or refused here, as a chat launch does — never two writers.
      try {
        await this.#chat.releaseWriterBeforeTerminal(stored.id);
      } catch (error) {
        throw new LaunchSpawnError(
          stored.kind,
          error instanceof ChatLaunchError
            ? error.message
            : redactLaunchError(error, referencedValues),
        );
      }
      const command = this.#agentCommand(stored.kind);
      env["CORRAL_STATUS_URL"] = this.#statusUrl(stored.id);
      env["CORRAL_STATUS_TOKEN"] = statusToken;
      if (!isExecutable(command, env["PATH"])) throw new AgentNotFoundError(command);
      input.command = command;
      // Codex assigns a new id to a conversation it starts, and a thread `thread/start` created but
      // no turn wrote is not durable (`design.md`): a recorded id with no rollout is forgotten, and
      // the launch below starts a new conversation and looks for its rollout.
      conversationId = resumable ? stored.agentSessionId : null;
      if (!resumable && stored.kind === "codex" && stored.agentSessionId !== null) {
        this.#store.setAgentSessionId(stored.id, null);
        this.#changes.notify();
      }
      let args = [
        ...adapter.launchArgs(stored.launch?.model ?? null, stored.launch?.provider ?? null),
        ...(resumable && recordedConversationId !== null
          ? adapter.resumeArgs(recordedConversationId)
          : adapter.startArgs(recordedConversationId)),
        // A fallback start is a new conversation under the same id; only it may carry the prompt.
        ...(prompt !== null && !resumable ? adapter.promptArgs(prompt) : []),
      ];
      if (stored.kind === "opencode") {
        // The terminal is a client of the one server this run shares with the chat driver, so the
        // two frontends are live at once: `--server <url> --session <id>` (`design.md`,
        // **Terminal and chat**). A server that cannot start falls back to OpenCode's own private
        // one and its status plugin; that session cannot open chat (two servers would be two
        // writers on one conversation) until it is stopped and started again.
        let server: { url: string; password: string } | undefined;
        try {
          server = await this.#openCodeServer("terminal", stored, task, command, env);
        } catch (error) {
          if (error instanceof ChatLaunchError)
            throw new LaunchSpawnError(stored.kind, error.message);
          server = undefined;
        }
        if (server === undefined) {
          standalone = true;
          const plugin = this.#openCode.launch(env);
          if (plugin) {
            args = [...plugin.args, ...args];
            Object.assign(env, plugin.env);
          }
        } else {
          env["OPENCODE_SERVER_PASSWORD"] = server.password;
          args = [...openCodeServerArgs(server.url), ...args];
        }
      }
      if (stored.kind === "codex") {
        // Measured (`.e2e/stage-c/c3/probe/`): a plain `codex` starts its own managed daemon, and
        // a thread another app-server holds is read-only there. The terminal is therefore a client
        // of this session's app-server (`--remote unix://…`), the same one chat attaches to — that
        // is what makes the two views live at once. An untested CLI keeps the plain launch, and
        // chat refuses with its reason. With a chat frontend already live, a plain terminal launch
        // would be a second writer, so the launch fails instead of falling back.
        const chatLive = this.#live.get(stored.id)?.chat === true;
        const support = await codexChatSupport(command, env);
        if (!support.supported) {
          if (chatLive) throw new LaunchSpawnError(stored.kind, support.reason);
          standaloneCodex = true;
          codexChatReason = support.reason;
        } else {
          try {
            const server = await this.#codexServer("terminal", stored, task, command, env);
            args = [...codexRemoteArgs(server.socketPath), ...args];
          } catch (error) {
            if (error instanceof ChatLaunchError)
              throw new LaunchSpawnError(stored.kind, error.message);
            const reason = redactLaunchError(error, referencedValues);
            if (chatLive)
              throw new LaunchSpawnError(
                stored.kind,
                `chat is live on this session but its Codex app-server could not be reached (${reason}); stop the session and start it again`,
              );
            standaloneCodex = true;
            codexChatReason = `this session's Codex app-server could not start (${reason}); stop it and start it again to open chat`;
          }
        }
      }
      input.args = args;
    }
    input.env = env;
    const spawnedAt = Date.now();
    let info: TerminalInfo;
    try {
      info = this.#terminals.create(
        input,
        { taskId: stored.taskId, sessionId: stored.id },
        // The token names this launch: a terminal being replaced must not write over the new one's status.
        // OSC 7501 fills in only until the launch's first accepted HTTP report (Orca's rule: the plugin wins).
        (status) => {
          const current = this.#live.get(stored.id);
          if (
            current?.terminalId === info.id &&
            current.statusToken === statusToken &&
            !current.reportedOverHttp
          )
            this.#setStatus(stored.id, status);
        },
      );
    } catch (error) {
      // The pool client was acquired before the PTY existed; a spawn that failed leaves it behind.
      await this.#openCodeServers.release(openCodeOwner("terminal", stored.id));
      await this.#codexServers.release(codexOwner("terminal", stored.id), stored.id);
      throw new LaunchSpawnError(stored.kind, redactLaunchError(error, referencedValues));
    }
    if (previous === undefined) this.#statuses.delete(stored.id);
    const discovery =
      stored.kind === "codex" && conversationId === null
        ? watchForCodexSession({
            home: codexHome(env),
            cwd: task.workspacePath,
            since: spawnedAt,
            claimedIds: () => this.#store.agentSessionIds("codex"),
            onFound: (agentSessionId) => {
              // A chat frontend that started its own thread (and stored its id) wins: the rollout
              // this search finds is the terminal's, not the conversation the session now runs.
              // Checked here, not only before the search starts, because the final look can run
              // after chat reported its id.
              if (adoptDiscoveredAgentSessionId(this.#store, stored.id, agentSessionId))
                this.#changes.notify();
            },
          })
        : undefined;
    // One `Live` object per session, mutated by each leg: the callbacks of a chat frontend and of
    // a terminal created later both see the same record, so a leg ending cannot read a stale copy.
    const live: Live = previous ?? {
      terminalId: null,
      chat: false,
      discovery,
      statusToken,
      chatStatusToken: statusToken,
      reportedOverHttp: false,
      standaloneOpenCode: standalone,
      standaloneCodex,
      codexChatReason,
    };
    live.terminalId = info.id;
    live.discovery = discovery;
    live.statusToken = statusToken;
    live.reportedOverHttp = false;
    live.standaloneOpenCode = standalone;
    live.standaloneCodex = standaloneCodex;
    live.codexChatReason = codexChatReason;
    this.#live.set(stored.id, live);
    this.#launchErrors.delete(stored.id);
    void this.#terminals
      .get(info.id)
      ?.whenExitRecorded()
      .then(() => this.#exitedByItself(stored.id, live, "terminal"));
  }

  /**
   * Starts one chat session's frontend through its agent's driver. The executable, launch
   * environment and `CORRAL_*` variables are the same a terminal launch gets; the chat argv
   * (`--mode rpc`, the model flags, the session id) belongs to the driver, so this service knows no
   * agent's flags and a new driver adds no branch here. The prompt travels with the launch, not as
   * an argument: a driver hands it over only when the conversation turns out to be empty.
   */
  async #launchChat(
    stored: StoredSession,
    kind: AgentKind,
    task: Task,
    env: Record<string, string>,
    statusToken: string,
    resume: boolean,
    prompt: string | null,
    referencedValues: readonly string[],
  ): Promise<void> {
    const command = this.#agentCommand(kind);
    env["CORRAL_STATUS_URL"] = this.#statusUrl(stored.id);
    env["CORRAL_STATUS_TOKEN"] = statusToken;
    if (!isExecutable(command, env["PATH"])) throw new AgentNotFoundError(command);
    const previous = this.#live.get(stored.id);
    if (kind === "opencode" && previous?.standaloneOpenCode) {
      // That terminal writes the same conversation through a server of its own; a second server
      // here would be a second writer. Stopping the session drops the flag, and the next start
      // tries the shared server again.
      throw new ChatLaunchError(
        "this session runs on OpenCode's own private server; stop it and start it again to open chat",
      );
    }
    if (kind === "codex" && previous?.standaloneCodex) {
      // The live terminal writes the thread through an app-server of its own (or a plain managed
      // daemon); a second one here would be a second writer. Stopping the session drops the flag.
      throw new ChatLaunchError(
        previous.codexChatReason ??
          "this session runs on Codex's own server; stop it and start it again to open chat",
      );
    }
    // A terminal leg may still be looking for its rollout. A chat frontend that opens first starts
    // its own thread and stores that id, and the late discovery must not overwrite it; finishing the
    // search before chat starts is what makes that deterministic (its `onFound` is guarded too).
    // If the search did find the terminal's conversation, chat adopts it instead of starting one.
    if (kind === "codex" && previous?.discovery !== undefined) {
      const discovery = previous.discovery;
      previous.discovery = undefined;
      await discovery.finish();
    }
    const owner = openCodeOwner("chat", stored.id);
    const codexOwnerId = codexOwner("chat", stored.id);
    let server: { url: string; password: string } | undefined;
    let socket: string | undefined;
    try {
      if (kind === "opencode")
        server = await this.#openCodeServer("chat", stored, task, command, env);
      if (kind === "codex") {
        const support = await codexChatSupport(command, env);
        if (!support.supported) throw new ChatLaunchError(support.reason);
        socket = (await this.#codexServer("chat", stored, task, command, env)).socketPath;
      }
    } catch (error) {
      throw new LaunchSpawnError(
        stored.kind,
        error instanceof ChatLaunchError
          ? error.message
          : redactLaunchError(error, referencedValues),
      );
    }
    const live: Live = previous ?? {
      terminalId: null,
      chat: false,
      discovery: undefined,
      statusToken,
      chatStatusToken: statusToken,
      reportedOverHttp: false,
      standaloneOpenCode: false,
      standaloneCodex: false,
      codexChatReason: undefined,
    };
    live.chat = true;
    live.chatStatusToken = statusToken;
    live.reportedOverHttp = false;
    live.standaloneOpenCode = false;
    try {
      await this.#chat.launch({
        sessionId: stored.id,
        kind,
        command,
        cwd: task.workspacePath,
        env,
        model: stored.launch?.model ?? null,
        provider: stored.launch?.provider ?? null,
        agentSessionId: stored.agentSessionId,
        // The decision `#launch` already made for this launch, shared with the terminal leg.
        how: resume ? "resume" : "start",
        prompt,
        ...(server === undefined ? {} : { server }),
        ...(socket === undefined ? {} : { socket }),
        // A live terminal leg can answer a request the chat driver does not render (a permissions
        // profile, an elicitation); a chat-only session has nobody else, so the driver refuses it
        // visibly instead of leaving the turn waiting. Asked per request: the terminal may `/quit`
        // after this launch, and a dead one must not swallow the refusal.
        terminalLive: () => this.#terminalAlive(stored.id),
        // Codex assigns the thread id; the session row learns it from the frontend.
        onAgentSessionId: (agentSessionId) => {
          this.#store.setAgentSessionId(stored.id, agentSessionId);
          this.#changes.notify();
        },
        onStatus: (status) => {
          const current = this.#live.get(stored.id);
          if (current?.chat && current.chatStatusToken === statusToken)
            this.#setStatus(stored.id, status);
        },
        onExit: (reason) => {
          void this.#openCodeServers.release(owner);
          void this.#codexServers.release(codexOwnerId, stored.id);
          if (reason !== null) this.#launchErrors.set(stored.id, reason);
          void this.#exitedByItself(stored.id, live, "chat");
        },
      });
    } catch (error) {
      await this.#openCodeServers.release(owner);
      await this.#codexServers.release(codexOwnerId, stored.id);
      throw new LaunchSpawnError(
        stored.kind,
        error instanceof ChatLaunchError
          ? error.message
          : redactLaunchError(error, referencedValues),
      );
    }
    if (previous === undefined) this.#statuses.delete(stored.id);
    this.#live.set(stored.id, live);
    this.#launchErrors.delete(stored.id);
  }

  /**
   * The session's process ended on its own: no status change from the server, only what the agent
   * reported. A chat session's frontend is gone with it; a terminal stays listed until it is closed.
   */
  #exitedByItself(sessionId: string, live: Live, leg: "chat" | "terminal"): Promise<void> {
    return this.#queue.run(async () => {
      if (this.#shuttingDown || this.#live.get(sessionId) !== live) return;
      await live.discovery?.finish();
      live.discovery = undefined;
      if (leg === "terminal") {
        // The terminal keeps its place in the registry and this session's id: an exited terminal
        // is still listed until it is closed or the session starts again.
        await this.#openCodeServers.release(openCodeOwner("terminal", sessionId));
        await this.#codexServers.release(codexOwner("terminal", sessionId), sessionId);
      } else {
        live.chat = false;
        await this.#openCodeServers.release(openCodeOwner("chat", sessionId));
        await this.#codexServers.release(codexOwner("chat", sessionId), sessionId);
      }
      // A both-live session keeps its other frontend; only the last leg ending settles it.
      if (!live.chat && !this.#terminalAlive(sessionId)) {
        if (live.terminalId === null) this.#live.delete(sessionId);
        this.#settle(sessionId);
      }
      this.#changes.notify();
    });
  }

  /** Whether this session's terminal leg is still running (an exited one is listed but dead). */
  #terminalAlive(sessionId: string): boolean {
    const live = this.#live.get(sessionId);
    if (live?.terminalId === null || live?.terminalId === undefined) return false;
    return this.#terminals.get(live.terminalId)?.info.exit === null;
  }

  /** Starts a stopped session again, an agent resumed; one that cannot start becomes `stopped`. */
  async #relaunch(stored: StoredSession): Promise<void> {
    try {
      // Starting it again would open a new conversation, which the user did not ask for.
      if (stored.kind === "codex" && stored.agentSessionId === null) {
        this.#store.setState(stored.id, "unresumable");
        return;
      }
      // A restored primary session whose agent never wrote a conversation starts one, and only
      // that launch takes the prompt; a real resume drops it inside `#launch`.
      await this.#launch(
        stored,
        this.#task(stored.taskId),
        UNATTACHED_SIZE,
        "resume",
        this.#taskPrompt(stored) ?? null,
      );
      this.#store.setState(stored.id, "running");
    } catch (error) {
      const reason = launchFailureReason(error);
      this.#launchErrors.set(stored.id, reason);
      console.error(
        `corral-server: could not restore session ${stored.id} (${stored.kind}): ${reason}`,
        launchDiagnostic(error),
      );
      this.#store.setState(stored.id, "stopped");
    }
  }

  /** Kills the session's frontend, closes its terminal and ends the search for its id. */
  async #halt(id: string): Promise<void> {
    const live = this.#live.get(id);
    if (!live) return;
    if (live.chat) {
      await this.#chat.stop(id);
      // The database release happens even when the driver already did it from `onExit`: it then
      // waits for the stop in flight, so an immediate restart cannot join a dying server.
      await this.#openCodeServers.release(openCodeOwner("chat", id));
      await this.#codexServers.release(codexOwner("chat", id), id);
    }
    if (live.terminalId !== null) {
      await this.#terminals.close(live.terminalId);
      await this.#openCodeServers.release(openCodeOwner("terminal", id));
      await this.#codexServers.release(codexOwner("terminal", id), id);
    }
    await live.discovery?.finish();
    this.#live.delete(id);
  }

  #setStatus(id: string, status: AgentStatus | null): void {
    if (sameStatus(this.#statuses.get(id) ?? null, status)) return;
    if (status) this.#statuses.set(id, status);
    else this.#statuses.delete(id);
    this.#changes.notify();
  }

  /** A session whose process is gone: `stopped`, unless it is a Codex session whose id was never learned. */
  #settle(id: string): void {
    this.#setStatus(id, statusAfterExit(this.#statuses.get(id) ?? null));
    const stored = this.#store.get(id);
    if (!stored) return;
    const lost = stored.kind === "codex" && stored.agentSessionId === null;
    this.#store.setState(id, lost ? "unresumable" : "stopped");
  }
}

/**
 * Stores a conversation id a rollout search found, unless the row already has one. A chat frontend
 * that opened its own thread stores its id first; the terminal's late discovery must not take the
 * session over. Returns whether anything was stored.
 */
export function adoptDiscoveredAgentSessionId(
  store: {
    get(sessionId: string): { agentSessionId: string | null } | undefined;
    setAgentSessionId(sessionId: string, agentSessionId: string | null): void;
  },
  sessionId: string,
  agentSessionId: string,
): boolean {
  if (store.get(sessionId)?.agentSessionId != null) return false;
  store.setAgentSessionId(sessionId, agentSessionId);
  return true;
}

/** Names one leg of a session's launch as a client of the shared server (acquire/release idempotent). */
function openCodeOwner(leg: "chat" | "terminal", sessionId: string): string {
  return `${leg}:${sessionId}`;
}

/** The same, for the per-session Codex app-server the two legs of one session share. */
function codexOwner(leg: "chat" | "terminal", sessionId: string): string {
  return `${leg}:${sessionId}`;
}

function stringEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
