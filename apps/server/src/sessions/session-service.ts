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
import type { ChatService } from "../chat/chat-service.ts";
import { ChatLaunchError, type ChatSubject } from "../chat/chat-errors.ts";
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
  statusToken: string;
  /** Once this launch has had an HTTP report accepted, its OSC 7501 reports no longer change the status. */
  reportedOverHttp: boolean;
}

export type StatusReportOutcome = "accepted" | "unknown-session" | "forbidden";

export class SessionService {
  readonly #store: SessionStore;
  readonly #tasks: TaskStore;
  readonly #terminals: TerminalRegistry;
  readonly #chat: ChatService;
  readonly #live = new Map<string, Live>();
  readonly #statusUrl: (sessionId: string) => string;
  readonly #openCode: OpenCodeIntegration;
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
      if (previous?.chat) await this.#chat.stop(id);
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
      if (previous?.terminalId) await this.#terminals.close(previous.terminalId);
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
    if (stored.view === "chat") {
      // A chat view is only created for an agent with a driver, and a shell never has one.
      if (stored.kind === "shell") throw new LaunchViewUnsupportedError(stored.kind, stored.view);
      await this.#launchChat(
        stored,
        stored.kind,
        task,
        env,
        statusToken,
        how,
        prompt,
        referencedValues,
      );
      return;
    }
    const input: CreateTerminalInput = { cwd: task.workspacePath, size };
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
      const id = stored.agentSessionId;
      const resumable =
        how === "resume" && id !== null && (adapter.hasConversation?.(id, env) ?? true);
      let args = [
        ...adapter.launchArgs(stored.launch?.model ?? null, stored.launch?.provider ?? null),
        ...(resumable ? adapter.resumeArgs(id) : adapter.startArgs(id)),
        // A fallback start is a new conversation under the same id; only it may carry the prompt.
        ...(prompt !== null && !resumable ? adapter.promptArgs(prompt) : []),
      ];
      if (stored.kind === "opencode") {
        const plugin = this.#openCode.launch(env);
        if (plugin) {
          args = [...plugin.args, ...args];
          Object.assign(env, plugin.env);
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
          if (current?.statusToken === statusToken && !current.reportedOverHttp)
            this.#setStatus(stored.id, status);
        },
      );
    } catch (error) {
      throw new LaunchSpawnError(stored.kind, redactLaunchError(error, referencedValues));
    }
    this.#statuses.delete(stored.id);
    const discovery =
      stored.kind === "codex" && stored.agentSessionId === null
        ? watchForCodexSession({
            home: codexHome(env),
            cwd: task.workspacePath,
            since: spawnedAt,
            claimedIds: () => this.#store.agentSessionIds("codex"),
            onFound: (agentSessionId) => {
              this.#store.setAgentSessionId(stored.id, agentSessionId);
              this.#changes.notify();
            },
          })
        : undefined;
    const live: Live = {
      terminalId: info.id,
      chat: false,
      discovery,
      statusToken,
      reportedOverHttp: false,
    };
    this.#live.set(stored.id, live);
    this.#launchErrors.delete(stored.id);
    void this.#terminals
      .get(info.id)
      ?.whenExitRecorded()
      .then(() => this.#exitedByItself(stored.id, live));
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
    how: "start" | "resume",
    prompt: string | null,
    referencedValues: readonly string[],
  ): Promise<void> {
    const command = this.#agentCommand(kind);
    env["CORRAL_STATUS_URL"] = this.#statusUrl(stored.id);
    env["CORRAL_STATUS_TOKEN"] = statusToken;
    if (!isExecutable(command, env["PATH"])) throw new AgentNotFoundError(command);
    const live: Live = {
      terminalId: null,
      chat: true,
      discovery: undefined,
      statusToken,
      reportedOverHttp: false,
    };
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
        // A session that has an id but no conversation to resume starts one under that id.
        how: how === "resume" && stored.agentSessionId !== null ? "resume" : "start",
        prompt,
        onStatus: (status) => {
          const current = this.#live.get(stored.id);
          if (current?.statusToken === statusToken) this.#setStatus(stored.id, status);
        },
        onExit: (reason) => {
          if (reason !== null) this.#launchErrors.set(stored.id, reason);
          void this.#exitedByItself(stored.id, live);
        },
      });
    } catch (error) {
      throw new LaunchSpawnError(
        stored.kind,
        error instanceof ChatLaunchError
          ? error.message
          : redactLaunchError(error, referencedValues),
      );
    }
    this.#statuses.delete(stored.id);
    this.#live.set(stored.id, live);
    this.#launchErrors.delete(stored.id);
  }

  /**
   * The session's process ended on its own: no status change from the server, only what the agent
   * reported. A chat session's frontend is gone with it; a terminal stays listed until it is closed.
   */
  #exitedByItself(sessionId: string, live: Live): Promise<void> {
    return this.#queue.run(async () => {
      if (this.#shuttingDown || this.#live.get(sessionId) !== live) return;
      await live.discovery?.finish();
      live.discovery = undefined;
      if (live.chat) this.#live.delete(sessionId);
      this.#settle(sessionId);
      this.#changes.notify();
    });
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
    if (live.terminalId === null) await this.#chat.stop(id);
    else await this.#terminals.close(live.terminalId);
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

function stringEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
