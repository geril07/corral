import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { ChatAnswer, ChatItemId, ChatModelRef, ChatStreamMessage } from "./chat.ts";
import { AgentKind, EnvRef, TaskView, configContract } from "./config.ts";
import { Label } from "./label.ts";

/** Control channel, served at `RPC_PATH` over WebSocket with oRPC. Terminal bytes go elsewhere. */
export const RPC_PATH = "/rpc";

export const TerminalId = z.string().min(1);

export const TerminalSize = z.object({
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});
export type TerminalSize = z.infer<typeof TerminalSize>;

export const TerminalExit = z.object({
  exitCode: z.number().int(),
  signal: z.number().int().optional(),
});
export type TerminalExit = z.infer<typeof TerminalExit>;

export const ProjectId = z.string().min(1);
export const TaskId = z.string().min(1);

export const SessionId = z.string().min(1);
export type SessionId = z.infer<typeof SessionId>;

export const TerminalInfo = z.object({
  id: TerminalId,
  /** The task the terminal works in; `null` for a terminal outside any task. */
  taskId: TaskId.nullable(),
  /** The session this terminal runs; `null` for a loose terminal. Every terminal in a task belongs to a session. */
  sessionId: SessionId.nullable(),
  /** Executable and arguments the PTY runs. */
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  size: TerminalSize,
  /** Set once the process exits. An exited terminal stays listed until it is closed. */
  exit: TerminalExit.nullable(),
  /**
   * The user's name for a loose terminal, shown instead of the one derived from the command;
   * `null` means none. Kept for as long as the terminal lives: terminals do not survive a
   * server restart (decision 12). Absent from a server that predates labels.
   */
  label: Label.nullable().optional(),
});
export type TerminalInfo = z.infer<typeof TerminalInfo>;

/** A loose terminal outside any task; terminals in a task are started as sessions. */
export const CreateTerminalInput = z.object({
  /** Defaults to the user's login shell (`$SHELL`). */
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  /** Defaults to the user's home directory. */
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  size: TerminalSize,
});
export type CreateTerminalInput = z.infer<typeof CreateTerminalInput>;

/** A git repository the user works in. */
export const Project = z.object({
  id: ProjectId,
  /** Directory name of the repository, unless renamed later. */
  name: z.string(),
  /** Absolute path of the main working tree. */
  path: z.string(),
  /** Branch new tasks start from unless told otherwise: `origin/HEAD`'s branch, else the current branch. */
  defaultBaseBranch: z.string(),
});
export type Project = z.infer<typeof Project>;

/** Where a task's issue came from. */
export const IssueProvider = z.enum(["github", "gitlab"]);
export type IssueProvider = z.infer<typeof IssueProvider>;

/**
 * A snapshot of the GitHub or GitLab issue a task was imported from. The local task title may
 * change; this record keeps the issue's title, text and URL as they were fetched.
 */
export const TaskSource = z.object({
  provider: IssueProvider,
  /** Host the issue lives on, including its port when the URL had one. */
  host: z.string().min(1).max(300),
  /** `OWNER/REPO` for GitHub, `GROUP/PROJECT` (nested groups included) for GitLab. */
  repository: z.string().min(1).max(512),
  number: z.number().int().positive(),
  /** The canonical issue URL; the only URL the server hands to a CLI. */
  url: z.string().min(1).max(2048),
  /** The issue's title as fetched, which is the default task title. */
  title: z.string().min(1).max(1024),
  /** The issue's text as fetched. Task context, never a shell argument. */
  body: z.string().max(1024 * 1024),
  /** Epoch milliseconds of the read-only fetch. */
  fetchedAt: z.number().int(),
});
export type TaskSource = z.infer<typeof TaskSource>;

/**
 * Where a task's current title came from: the prompt-derived seed, the naming request, or the
 * user. Kept so generation never overwrites a title the user chose.
 */
export const TaskTitleSource = z.enum(["seed", "generated", "user"]);
export type TaskTitleSource = z.infer<typeof TaskTitleSource>;

/**
 * A unit of work in a project. Its workspace is either its own git worktree on its own branch
 * (the default), or the project's main working tree.
 */
export const Task = z.object({
  id: TaskId,
  projectId: ProjectId,
  title: z.string().min(1),
  /** What the title came from; a rename always makes it `user`. */
  titleSource: TaskTitleSource,
  /** Set when the task was created from an issue URL; absent for tasks made by hand. */
  source: TaskSource.optional(),
  /**
   * What the task's primary agent was started with, and what its first launch passes to the agent
   * (`promptArgs`); `null` for a task made without one. Kept so a restart that has no conversation
   * to resume can hand it over again.
   */
  prompt: z.string().nullable(),
  /**
   * The session created from the prompt (design.md, **Sessions**); `null` until a task has one, and
   * again when that session is removed.
   */
  primarySessionId: SessionId.nullable(),
  /** Branch checked out in the workspace; for a task in the main working tree, whatever is checked out there at creation. */
  branch: z.string(),
  /** Absolute path the task's terminals start in. */
  workspacePath: z.string(),
  /** True when the workspace is a worktree this task created and owns. */
  ownsWorktree: z.boolean(),
  /**
   * Set by the user. `settled`: the work is done; the task keeps its worktree and branch but
   * runs nothing. Derived agent status arrives with agent sessions.
   */
  state: z.enum(["active", "settled"]),
  /**
   * Epoch milliseconds when the user last looked at this task's agent updates, `null` until then.
   * The server owns it so every client agrees on which completions are unseen: a `done` status
   * newer than this is completed and unseen (`tasks.markSeen`).
   */
  seenAt: z.number().nullable(),
  /** Epoch milliseconds. */
  createdAt: z.number(),
});
export type Task = z.infer<typeof Task>;

/**
 * An agent the task's primary session starts. The shape `sessions.start` takes, without a shell: a
 * task never starts one on its own (design.md, **Domain model → Task → Creation**).
 */
export const TaskAgent = z.object({
  kind: AgentKind,
  profileId: z.string().min(1).optional(),
  expectedProfileRevision: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});
export type TaskAgent = z.infer<typeof TaskAgent>;

/**
 * The most a prompt may hold, in UTF-8 bytes. It reaches the agent as one argv word, which Linux
 * caps at 128 KiB (`MAX_ARG_STRLEN`), and the adapter puts a space or a flag around it
 * (`promptArgs`), so half the limit leaves room. Bytes, not characters: an astral character costs
 * four, so a character count would let a prompt through that no launch can carry.
 */
export const MAX_TASK_PROMPT = 64 * 1024;

const UTF8 = new TextEncoder();

/** How many bytes `text` takes as UTF-8, the unit an argv limit is counted in. */
function utf8Length(text: string): number {
  return UTF8.encode(text).length;
}

/** A prompt short enough to reach an agent as one argument. Trimmed first, so padding costs nothing. */
const TaskPrompt = z
  .string()
  .trim()
  .refine((text) => utf8Length(text) <= MAX_TASK_PROMPT, {
    message: `a task prompt may hold at most ${MAX_TASK_PROMPT} bytes of UTF-8`,
  });

export const CreateTaskInput = z
  .object({
    projectId: ProjectId,
    /**
     * Defaults to `source.title`, then to the prompt's seed title (its first line, shortened).
     * An explicit title always wins and is the user's.
     */
    title: z.string().trim().min(1).optional(),
    source: TaskSource.optional(),
    /** What the primary agent starts working on. Trimmed; blank is the same as absent. */
    prompt: TaskPrompt.optional(),
    /** Starts this agent as the task's primary session, with `prompt`; absent starts no session. */
    agent: TaskAgent.optional(),
    workspace: z.discriminatedUnion("type", [
      /** New branch (named from the title unless given) off `baseBranch` (default: the project's), in a new worktree. */
      z.object({
        type: z.literal("new-branch"),
        branch: z.string().min(1).optional(),
        baseBranch: z.string().min(1).optional(),
      }),
      /** An existing local or remote-tracking branch, checked out in a new worktree. */
      z.object({ type: z.literal("existing-branch"), branch: z.string().min(1) }),
      /** No worktree: the task works in the project's main working tree. */
      z.object({ type: z.literal("main-worktree") }),
    ]),
  })
  .refine(
    (input) =>
      input.title !== undefined ||
      input.source !== undefined ||
      (input.prompt !== undefined && input.prompt !== ""),
    {
      message: "a title is required unless the task comes from an issue source or a prompt",
      path: ["title"],
    },
  );
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

/** A URL the server may resolve through its own `gh` or `glab` login for an existing project. */
export const ResolveIssueInput = z.object({
  projectId: ProjectId,
  url: z.string().trim().min(1).max(2048),
  /** Required when the URL's host is neither github.com, gitlab.com nor a ghe.com host. */
  provider: IssueProvider.optional(),
});
export type ResolveIssueInput = z.infer<typeof ResolveIssueInput>;

export { AgentKind } from "./config.ts";
export const SessionKind = z.enum(["shell", ...AgentKind.options]);
export type SessionKind = z.infer<typeof SessionKind>;

/**
 * How a session runs: as a terminal, or as chat through its agent's driver (design.md, decision 5).
 * One vocabulary with a task's view (`TaskView`). Input may omit it — stored sessions have no view
 * column until B1's migration — and reads back as `terminal`; output always carries it. A shell is
 * always `terminal`, which the server must refuse to violate when a view becomes a choice (B1).
 */
export const SessionView = TaskView;
export type SessionView = z.infer<typeof SessionView>;

export const AgentState = z.enum(["working", "blocked", "done", "error", "idle"]);
export type AgentState = z.infer<typeof AgentState>;

/**
 * What an agent last reported about itself (OSC 7501, or a plugin for agents without it).
 * `kind` says what a `blocked` agent waits for.
 */
export const AgentStatus = z.object({
  state: AgentState,
  kind: z.enum(["permission", "question", "auth"]).optional(),
  /** Short text from the agent: task summary, the approval it asks for, an error. */
  message: z.string().optional(),
  /** Epoch milliseconds of the report. */
  updatedAt: z.number(),
});
export type AgentStatus = z.infer<typeof AgentStatus>;

/**
 * The nonsecret launch choices a session was started with. Persisted and never re-read from the
 * config file, so editing or deleting a profile does not change an existing conversation.
 * Environment entries are names only; their values are resolved from the server environment
 * again on every launch.
 */
export const LaunchSnapshot = z.object({
  kind: AgentKind,
  /** The profile selected at start, with the revision it had then. `null` for a bare model choice. */
  profile: z.object({ id: z.string(), name: z.string(), revision: z.string() }).nullable(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  env: z.array(EnvRef),
});
export type LaunchSnapshot = z.infer<typeof LaunchSnapshot>;

/**
 * Something running in a task: a shell or an agent. Persisted, unlike terminals: after a
 * server restart every session that was running is started again, a shell fresh and an agent
 * resumed by `agentSessionId` (decision 12).
 */
export const Session = z.object({
  id: SessionId,
  taskId: TaskId,
  kind: SessionKind,
  /**
   * The view the session is shown in. A `chat` session runs a chat driver instead of a terminal
   * (`chat.*`); the server's storage carries it from B1 on. `terminal` when the sender omits it.
   */
  view: SessionView.default("terminal"),
  /**
   * The agent's own session id, used to resume it. Set at start for agents that accept one
   * (Claude Code, pi, OpenCode); discovered after start for Codex, so `null` until then.
   * Always `null` for a shell.
   */
  agentSessionId: z.string().nullable(),
  /** The live or exited terminal running it; `null` when stopped. */
  terminalId: TerminalId.nullable(),
  /**
   * `running`: its terminal's process is alive. `stopped`: not running and can be started
   * again (an agent then resumes). `unresumable`: an agent whose id was never learned, so
   * starting it again would open a new conversation.
   */
  state: z.enum(["running", "stopped", "unresumable"]),
  /**
   * The agent's last reported status; `null` for shells and for agents that reported nothing
   * yet. Cleared when the process exits, except `done` and `error`, which outlive it. Not
   * persisted across a server restart.
   */
  status: AgentStatus.nullable(),
  /**
   * The user's name for the session, shown instead of the natural label (`shell 2`); `null`
   * means none. Persisted, so it survives stop, restart, settling and a server restart. Absent
   * from a server that predates labels.
   */
  label: Label.nullable().optional(),
  /** Epoch milliseconds. */
  createdAt: z.number(),
  /**
   * The launch choices this session was started with. Absent on an old server; `null` for a
   * session with neither a profile nor a model choice (the unchanged default launch).
   */
  launch: LaunchSnapshot.nullable().optional(),
  /**
   * Why the last start or restore could not launch the session, safe to show and never holding
   * a resolved environment value. `null` when nothing failed or on an old server. Not persisted.
   */
  launchError: z.string().nullable().optional(),
});
export type Session = z.infer<typeof Session>;

/** How `chat.send` treats a message. */
export const ChatSendMode = z.enum(["prompt", "steer", "follow-up"]);
export type ChatSendMode = z.infer<typeof ChatSendMode>;

/** What `chat.watch` takes: the session, and the last sequence the client applied when resuming. */
export const ChatWatchInput = z.object({
  sessionId: SessionId,
  /**
   * The last sequence the client applied. The server replays the events after it, or starts with a
   * fresh snapshot when it no longer has them; omit it to ask for a snapshot outright.
   */
  after: z.number().int().nonnegative().optional(),
});
export type ChatWatchInput = z.infer<typeof ChatWatchInput>;

export const ChatSendInput = z.object({
  sessionId: SessionId,
  text: z.string().trim().min(1),
  /** `prompt` starts a turn, `steer` joins the running one, `follow-up` queues after it. */
  mode: ChatSendMode,
});
export type ChatSendInput = z.infer<typeof ChatSendInput>;

export const ChatRespondInput = z.object({
  sessionId: SessionId,
  /** The `id` of the `user-request` item to answer. */
  requestId: ChatItemId,
  /** A string for `input`, `editor` and `select`, a boolean for `confirm`, `null` to dismiss. */
  value: ChatAnswer,
});
export type ChatRespondInput = z.infer<typeof ChatRespondInput>;

export const ChatSetModelInput = z.object({
  sessionId: SessionId,
  /** One of the session's `models`. */
  model: ChatModelRef,
});
export type ChatSetModelInput = z.infer<typeof ChatSetModelInput>;

export const ChatSetReasoningInput = z.object({
  sessionId: SessionId,
  /** One of the session's `reasoningLevels`. */
  level: z.string().min(1),
});
export type ChatSetReasoningInput = z.infer<typeof ChatSetReasoningInput>;

const terminalNotFound = { NOT_FOUND: { data: z.object({ id: TerminalId }) } };
const projectNotFound = { PROJECT_NOT_FOUND: { data: z.object({ id: ProjectId }) } };
const taskNotFound = { TASK_NOT_FOUND: { data: z.object({ id: TaskId }) } };
const sessionNotFound = { SESSION_NOT_FOUND: { data: z.object({ id: SessionId }) } };
/** Input the wire schema accepts but a handler still refuses; `message` is shown to the user. */
const badRequest = { BAD_REQUEST: { data: z.object({ message: z.string() }) } };
/** A launch was refused before anything was spawned; `name` is a profile id or an env variable name, never a value. */
const launchRefused = {
  LAUNCH_PROFILE_UNKNOWN: { data: z.object({ id: z.string() }) },
  LAUNCH_PROFILE_CHANGED: { data: z.object({ id: z.string() }) },
  LAUNCH_PROFILE_REVISION_UNSUPPORTED: {},
  LAUNCH_PROFILE_KIND_MISMATCH: { data: z.object({ id: z.string(), kind: SessionKind }) },
  LAUNCH_MODEL_UNSUPPORTED: { data: z.object({ kind: SessionKind }) },
  LAUNCH_MODEL_INVALID: { data: z.object({ kind: SessionKind }) },
  LAUNCH_ENV_MISSING: { data: z.object({ profileId: z.string().nullable(), name: z.string() }) },
  LAUNCH_ENV_RESERVED: { data: z.object({ name: z.string() }) },
  /** An unexpected spawn failure; `message` is redacted against referenced environment values. */
  LAUNCH_FAILED: { data: z.object({ kind: SessionKind, message: z.string() }) },
};
/** Git refused or failed; `message` is git's own stderr, meant for the user. */
const gitFailed = { GIT_FAILED: { data: z.object({ message: z.string() }) } };
/**
 * Why chat is unavailable: `no-driver` — this build has no driver for the agent, so retrying
 * cannot help; `not-started` — the session's frontend is not running and can be started;
 * `exited` — it stopped and its last state is what the client already has.
 */
export const ChatUnavailableReason = z.enum(["no-driver", "not-started", "exited"]);
export type ChatUnavailableReason = z.infer<typeof ChatUnavailableReason>;

/** The session has no live chat driver; `message` is safe to show and `reason` says whether a retry can help. */
const chatUnavailable = {
  CHAT_UNAVAILABLE: {
    data: z.object({
      message: z.string(),
      reason: ChatUnavailableReason,
    }),
  },
};
const issueErrors = {
  /** The URL is not a GitHub or GitLab issue URL, or carries credentials or unsafe parts. */
  ISSUE_URL_INVALID: { data: z.object({ message: z.string() }) },
  /** The host is ambiguous and the caller did not say which provider it is. */
  ISSUE_PROVIDER_REQUIRED: { data: z.object({ host: z.string() }) },
  /** The host is not public and not configured by the project remote or operator environment. */
  ISSUE_HOST_UNTRUSTED: {
    data: z.object({ provider: IssueProvider, host: z.string() }),
  },
  /** GitHub issue URLs with a nonstandard port are not supported by gh 2.102. */
  ISSUE_UNSUPPORTED_PORT: {
    data: z.object({ provider: IssueProvider, host: z.string() }),
  },
  /** The matching CLI is not on the server's PATH. */
  ISSUE_CLI_MISSING: { data: z.object({ command: z.string() }) },
  /** The server's CLI has no usable login for the issue's host. */
  ISSUE_AUTH_REQUIRED: { data: z.object({ provider: IssueProvider }) },
  /** The CLI did not answer within the bounded import timeout. */
  ISSUE_FETCH_TIMEOUT: { data: z.object({ provider: IssueProvider }) },
  /** The CLI's output was not the documented JSON shape, or named another issue. */
  ISSUE_RESPONSE_INVALID: { data: z.object({ provider: IssueProvider }) },
  /** The CLI failed: no network, no such issue, or another error from the host. */
  ISSUE_FETCH_FAILED: {
    data: z.object({ provider: IssueProvider, message: z.string() }),
  },
};

export const contract = {
  config: configContract,
  projects: {
    /** Registers the git repository containing `path` (any directory inside it works). */
    add: oc
      .errors({
        NOT_A_GIT_REPOSITORY: { data: z.object({ path: z.string() }) },
        PROJECT_EXISTS: { data: z.object({ id: ProjectId }) },
        ...gitFailed,
      })
      .input(z.object({ path: z.string().min(1) }))
      .output(Project),
    /** Forgets the project and its tasks. Refused while it has tasks with live terminals; worktrees and branches stay on disk. */
    remove: oc
      .errors({ ...projectNotFound, HAS_LIVE_TERMINALS: {} })
      .input(z.object({ id: ProjectId }))
      .output(z.void()),
    /** Local branches and remote-tracking branches (`origin/x`), for the create-task form. */
    branches: oc
      .errors({ ...projectNotFound, ...gitFailed })
      .input(z.object({ id: ProjectId }))
      .output(z.array(z.string())),
    /**
     * Reads one GitHub or GitLab issue through the server host's own `gh`/`glab` login. Read-only:
     * the CLI gets a validated issue URL and a read command, nothing else. The result is a
     * snapshot for `tasks.create`; a failure leaves the draft for hand editing or a plain task.
     */
    resolveIssue: oc
      .errors({ ...projectNotFound, ...issueErrors })
      .input(ResolveIssueInput)
      .output(TaskSource),
    /** Yields all projects now and after every change. */
    watch: oc.output(eventIterator(z.array(Project))),
  },
  tasks: {
    create: oc
      .errors({ ...projectNotFound, ...gitFailed })
      .input(CreateTaskInput)
      .output(Task),
    /**
     * Settling stops the task's running sessions and remembers which ones ran; making it
     * active again starts exactly those (agents resume). Setting the current state is a no-op.
     */
    setState: oc
      .errors(taskNotFound)
      .input(z.object({ id: TaskId, state: Task.shape.state }))
      .output(Task),
    /**
     * Names the task for the user and records `titleSource = user`. Nothing else changes: the
     * branch keeps its name, the worktree its path, and the task its sessions.
     */
    rename: oc
      .errors({ ...taskNotFound, ...badRequest })
      .input(z.object({ id: TaskId, title: z.string().trim().min(1) }))
      .output(Task),
    /**
     * Removes the task's sessions (stopping them), removes a worktree the task owns and forgets the task. The
     * branch always stays. A worktree with uncommitted or untracked changes is kept and the
     * call fails with `WORKTREE_DIRTY`, unless `force` is set.
     */
    remove: oc
      .errors({
        ...taskNotFound,
        ...gitFailed,
        WORKTREE_DIRTY: { data: z.object({ files: z.array(z.string()) }) },
      })
      .input(z.object({ id: TaskId, force: z.boolean().optional() }))
      .output(z.void()),
    /**
     * Records that the user has seen the task's current agent update. The server stamps the time,
     * so every client derives the same "completed and unseen" state from the watched task.
     */
    markSeen: oc
      .errors(taskNotFound)
      .input(z.object({ id: TaskId }))
      .output(Task),
    /** Yields all tasks of every project now and after every change. */
    watch: oc.output(eventIterator(z.array(Task))),
  },
  sessions: {
    /**
     * Starts a shell or an agent in the task's workspace, in a new terminal. The agent CLI is
     * looked up on the server's `PATH`; a missing one fails with `AGENT_NOT_FOUND`.
     *
     * `profileId` selects a profile from the server's config file. `expectedProfileRevision`
     * pins the definition the caller showed; a profile that changed since then is refused with
     * `LAUNCH_PROFILE_CHANGED` before anything is spawned. Omitting it means latest by id.
     * `model` chooses a native model; it overrides the profile's model and needs no profile. A
     * model the agent kind cannot take is refused, never ignored. Choices are snapshotted.
     */
    start: oc
      .errors({
        ...taskNotFound,
        AGENT_NOT_FOUND: { data: z.object({ command: z.string() }) },
        ...launchRefused,
      })
      .input(
        z.object({
          taskId: TaskId,
          kind: SessionKind,
          size: TerminalSize,
          profileId: z.string().min(1).optional(),
          /** Only with `profileId`: the profile revision the caller last saw. */
          expectedProfileRevision: z.string().min(1).optional(),
          model: z.string().min(1).optional(),
        }),
      )
      .output(Session),
    /** Starts a `stopped` (or `unresumable`, as a new conversation) session again in a new terminal. */
    restart: oc
      .errors({
        ...sessionNotFound,
        ALREADY_RUNNING: {},
        AGENT_NOT_FOUND: { data: z.object({ command: z.string() }) },
        ...launchRefused,
      })
      .input(z.object({ id: SessionId, size: TerminalSize }))
      .output(Session),
    /** Kills its process and closes its terminal; the session stays, `stopped`. */
    stop: oc
      .errors(sessionNotFound)
      .input(z.object({ id: SessionId }))
      .output(Session),
    /** Stops it if running and forgets it. The agent's own history is left alone. */
    remove: oc
      .errors(sessionNotFound)
      .input(z.object({ id: SessionId }))
      .output(z.void()),
    /**
     * Names the session for the user, or with a blank label takes the name away again. Changes
     * nothing else: same session, same agent conversation, same running process.
     */
    setLabel: oc
      .errors(sessionNotFound)
      .input(z.object({ id: SessionId, label: Label.nullable() }))
      .output(Session),
    /** Yields all sessions now and after every change. */
    watch: oc.output(eventIterator(z.array(Session))),
  },
  chat: {
    /**
     * What this server build can show as chat: the agent kinds with a driver. A build fact, not a
     * session's state, so a client asks once per connection (the list changes when a driver lands).
     */
    capabilities: oc.output(z.object({ drivers: z.array(AgentKind) })),
    /**
     * Yields the chat of one session: a snapshot first, then sequenced events. With `after` it
     * yields what the client missed instead, or a fresh snapshot when those events are gone.
     * Sequences are contiguous per session; a hole means the client must watch again without `after`.
     * A stopped chat frontend is a `CHAT_UNAVAILABLE` refusal with `reason: "exited"`, not the end
     * of this iterator; ending is a last resort. A client treats a clean end as one retry from its
     * last sequence and then reports the failure until the connection changes, not as an unbounded
     * reconnect.
     */
    watch: oc
      .errors({ ...sessionNotFound, ...chatUnavailable })
      .input(ChatWatchInput)
      .output(eventIterator(ChatStreamMessage)),
    /**
     * Sends a message: starts a turn, steers the running one, or queues one after it. Returns the
     * id of the item it became, so a client can reconcile an optimistic user message with the one
     * the stream delivers instead of showing it twice.
     */
    send: oc
      .errors({ ...sessionNotFound, ...chatUnavailable })
      .input(ChatSendInput)
      .output(ChatItemId),
    /** Stops the turn the agent is working on. The session stays usable. */
    abort: oc
      .errors({ ...sessionNotFound, ...chatUnavailable })
      .input(z.object({ sessionId: SessionId }))
      .output(z.void()),
    /** Answers a user request the agent waits on; `null` dismisses it. */
    respond: oc
      .errors({
        ...sessionNotFound,
        ...chatUnavailable,
        CHAT_REQUEST_UNKNOWN: { data: z.object({ requestId: ChatItemId }) },
      })
      .input(ChatRespondInput)
      .output(z.void()),
    /** Runs the session on another model from its `models` list. */
    setModel: oc
      .errors({
        ...sessionNotFound,
        ...chatUnavailable,
        CHAT_MODEL_UNSUPPORTED: { data: z.object({ model: ChatModelRef }) },
      })
      .input(ChatSetModelInput)
      .output(z.void()),
    /** Sets the reasoning level to one from `reasoningLevels`. */
    setReasoning: oc
      .errors({
        ...sessionNotFound,
        ...chatUnavailable,
        CHAT_REASONING_UNSUPPORTED: { data: z.object({ level: z.string() }) },
      })
      .input(ChatSetReasoningInput)
      .output(z.void()),
  },
  terminals: {
    list: oc.output(z.array(TerminalInfo)),
    create: oc.errors(badRequest).input(CreateTerminalInput).output(TerminalInfo),
    /** Kills the process if it still runs and forgets the terminal. On a session's terminal this is `sessions.stop`. */
    close: oc
      .errors(terminalNotFound)
      .input(z.object({ id: TerminalId }))
      .output(z.void()),
    /**
     * Names a loose terminal for the user, or with a blank label takes the name away again; the
     * process keeps running. A terminal in a task is named through `sessions.setLabel`.
     */
    setLabel: oc
      .errors({ ...terminalNotFound, NOT_A_LOOSE_TERMINAL: {} })
      .input(z.object({ id: TerminalId, label: Label.nullable() }))
      .output(TerminalInfo),
    /** Yields the full list now and again after every change (create, exit, resize, close). */
    watch: oc.output(eventIterator(z.array(TerminalInfo))),
  },
};
export type Contract = typeof contract;
