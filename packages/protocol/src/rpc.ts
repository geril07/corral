import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import {
  ChatAnswer,
  ChatDriverCapabilities,
  ChatItemId,
  ChatModelRef,
  ChatStreamMessage,
} from "./chat.ts";
import { AgentKind, EnvRef, TaskView, configContract } from "./config.ts";
import { Label } from "./label.ts";
import { modelsContract } from "./models.ts";

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

/**
 * How a session runs: as a terminal, or as chat through its agent's driver (design.md, decision 5).
 * One vocabulary with a task's view (`TaskView`). A start may name it and a task's agent carries
 * it; a stored session always has one, and a shell is always `terminal`, which the server refuses
 * to violate (`LAUNCH_VIEW_UNSUPPORTED`).
 */
export const SessionView = TaskView;
export type SessionView = z.infer<typeof SessionView>;

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
 * How a changed file differs from the task's base: modified, added, deleted or renamed. A copy and
 * a type change are reported as an addition and a modification; the summary row has one letter per
 * file.
 */
export const ChangeStatus = z.enum(["M", "A", "D", "R"]);
export type ChangeStatus = z.infer<typeof ChangeStatus>;

/** One file a task changed, as `changes.files` lists it. */
export const ChangeFile = z.object({
  /** The path after the change: what `changes.diff` addresses. */
  path: z.string().min(1),
  /** The path before a rename; `null` for every other status. */
  oldPath: z.string().nullable(),
  status: ChangeStatus,
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  /** Git saw no text, or the worktree file holds a NUL byte in its first 8 kB. */
  binary: z.boolean(),
  /**
   * `additions` and `deletions` are a lower bound: an untracked file is counted from the first
   * 8 MiB of its bytes, and a file the server could not read is counted as zero. The header and the
   * sidebar mark a partial total instead of presenting it as final.
   */
  partial: z.boolean(),
  /**
   * Why this entry has no content to count or diff — unreadable, not a regular file — or `null`.
   * The entry is kept (rather than dropped) so the tab never shows a changed file as a clean tree.
   */
  note: z.string().nullable(),
});
export type ChangeFile = z.infer<typeof ChangeFile>;

/** What a task's changes are compared with. The server computes it on every read; nothing stores it. */
export const ChangesBase = z.object({
  /** The commit compared against; `null` when the repository has no commit yet. */
  commit: z.string().nullable(),
  /** What the commit is, for the summary row: the base branch's name, or `HEAD`. */
  label: z.string().min(1),
  /**
   * Why the base is not the merge base, for the summary row, or `null` when it is. A worktree whose
   * base branch is gone, or has no merge base with `HEAD`, falls back to `HEAD` and says so here
   * instead of failing.
   */
  fallback: z.string().nullable(),
});
export type ChangesBase = z.infer<typeof ChangesBase>;

/** The read model of one task's changes: the computed base and the changed files under it. */
export const TaskChanges = z.object({
  taskId: TaskId,
  base: ChangesBase,
  /** Changed files sorted by path, at most the server's cap; a clean task lists none. */
  files: z.array(ChangeFile),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  /** The task changed more files than the server lists; `additions` and `deletions` cover the listed ones. */
  truncated: z.boolean(),
  /**
   * Why the workspace could not be read (a worktree deleted behind Corral's back), or `null`.
   * One task failing must not end the watch for every other task.
   */
  error: z.string().nullable(),
});
export type TaskChanges = z.infer<typeof TaskChanges>;

/** One file's unified diff, as `changes.diff` returns it. */
export const ChangeDiff = z.object({
  path: z.string().min(1),
  /** The unified diff; `null` for a binary file and for one whose diff could not be read. */
  text: z.string().nullable(),
  binary: z.boolean(),
  /** The file's size in bytes when known: what the binary row shows instead of a diff. */
  size: z.number().int().min(0).nullable(),
  /** The diff was longer than the server's cap and is cut at a line boundary. */
  truncated: z.boolean(),
  /** Why there is no text to show (unreadable, not a regular file), or `null`. */
  note: z.string().nullable(),
});
export type ChangeDiff = z.infer<typeof ChangeDiff>;

/**
 * A git remote a write targets: its name for git's own argv, and the **push** URL
 * (`git remote get-url --push`, so `remote.<name>.pushurl` wins over the fetch URL and an
 * `insteadOf` rewrite is expanded) — the address a push really reaches, exactly as the user was
 * shown it. Every remote write carries the pair back, and the server re-reads both before git runs
 * and refuses a URL that is no longer the confirmed one (`CHANGES_REMOTE_MISMATCH`): an edited
 * `.git/config` can change a remote between the confirmation and the write.
 */
export const ChangesRemote = z.object({
  name: z.string().min(1).max(200),
  /** The push URL, as `changes.finish` reported it. */
  url: z.string().min(1).max(2048),
});
export type ChangesRemote = z.infer<typeof ChangesRemote>;

/**
 * The finish panel's read model (`layout.md`, **Changes**): what the commit, push and pull-request
 * controls need to name in their confirmations. Read on mount and after every write; nothing here
 * writes to the repository or a remote.
 */
export const ChangesFinish = z.object({
  taskId: TaskId,
  /** The branch checked out in the task's workspace; `null` when HEAD is detached. */
  branch: z.string().nullable(),
  /** The branch a pull request would target: the project's default base branch. */
  base: z.string().nullable(),
  /**
   * The remote a push would use: the checked-out branch's configured remote, else `origin`, else
   * the only remote; `null` when none of those exists and the push is refused instead.
   */
  remote: ChangesRemote.nullable(),
  /** Every configured remote, so a confirmation can name one and a missing remote is visible. */
  remotes: z.array(ChangesRemote),
  /** Paths with staged changes, sorted; empty when nothing is in the index. */
  staged: z.array(z.string()),
});
export type ChangesFinish = z.infer<typeof ChangesFinish>;

/**
 * A linked pull request's state. `unknown` is a state of its own: a read that fails (offline, a
 * logged-out CLI, an answer Corral cannot read) never reports `closed`, and `stateReason` says why.
 */
export const PullRequestState = z.enum(["open", "draft", "merged", "closed", "unknown"]);
export type PullRequestState = z.infer<typeof PullRequestState>;

/** The check summary a task's badge and the Changes tab show; absent when the provider reports none. */
export const PullRequestChecks = z.object({
  total: z.number().int().min(0),
  passing: z.number().int().min(0),
  failing: z.number().int().min(0),
  pending: z.number().int().min(0),
  skipped: z.number().int().min(0),
});
export type PullRequestChecks = z.infer<typeof PullRequestChecks>;

/**
 * The pull or merge request opened from a task's branch: created by `changes.createPullRequest` and
 * kept on the task in its own table. The row outlives a state that cannot be read, so the link
 * stays and only `state`/`stateReason` change.
 */
export const PullRequest = z.object({
  taskId: TaskId,
  provider: IssueProvider,
  /** Host the request lives on, as the CLI reported it. */
  host: z.string().min(1).max(300),
  /**
   * The repository the request was opened on as one value with its host — `forge.example/acme/app`
   * (nested GitLab paths included) — when the task's remote named one. Kept on the row so a refresh
   * asks the CLI for that repository (`--repo`) instead of whichever one it happens to resolve, and
   * so a forge that redirects the request's own host cannot move the read. Optional: a daemon
   * already on version 10 answers without it, and a task whose remote is a local path has none.
   */
  repository: z.string().max(560).nullable().optional(),
  number: z.number().int().positive(),
  url: z.string().min(1).max(2048),
  title: z.string().max(1024),
  /** Branch the request was opened from; `null` for a snapshot stored before a refresh had one. */
  branch: z.string().nullable(),
  /** Branch it targets. */
  base: z.string().nullable(),
  state: PullRequestState,
  /** Why `state` is `unknown`; `null` for every other state. */
  stateReason: z.string().nullable(),
  checks: PullRequestChecks.nullable(),
  /** Epoch milliseconds of the last read through the CLI; `null` until the first refresh. */
  fetchedAt: z.number().int().nullable(),
});
export type PullRequest = z.infer<typeof PullRequest>;

/** The most a commit message may hold, in characters; git has no limit, the UI does. */
export const MAX_COMMIT_MESSAGE = 8192;

/** A pull request's title, one line like the task title it defaults to. */
export const MAX_PULL_REQUEST_TITLE = 256;

/**
 * An agent the task's primary session starts. The shape `sessions.start` takes, without a shell: a
 * task never starts one on its own (design.md, **Domain model → Task → Creation**).
 */
export const TaskAgent = z.object({
  kind: AgentKind,
  profileId: z.string().min(1).optional(),
  expectedProfileRevision: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  /**
   * How the primary session opens. Omitted takes the project's configured view (`[tasks] view`,
   * overridable per project); a `chat` view the agent has no driver for opens in the terminal.
   */
  view: SessionView.optional(),
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
   * (`chat.*`) and has no terminal; its live frontend is the agent's RPC child. Persisted, so a
   * restore resumes the same id in the same view. The default keeps "absent means terminal" one
   * definition: a protocol 9 server from before B1's migration sends no view, and the version
   * barrier cannot tell it apart from this one.
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

/** What an inline chat preview can show, decided by the file's extension. */
export const FileMedia = z.enum(["image", "video"]);
export type FileMedia = z.infer<typeof FileMedia>;

/** How many bytes a path lookup may hand back for an inline preview, per media kind. */
export const FILE_PREVIEW_LIMITS = { image: 4 * 1024 * 1024, video: 8 * 1024 * 1024 } as const;

/** The longest path a `files.*` call carries; a longer token is text, not a candidate. */
export const FILE_PATH_MAX = 4096;

/**
 * How many candidates one `files.resolve` call may carry. A chat lane accumulates them across every
 * message it shows, so a client splits its work into calls of this size (`candidateBatches`).
 */
export const FILE_RESOLVE_BATCH = 64;

/**
 * One path a task's workspace holds, as `files.resolve` found it. `requested` is the caller's own
 * text so a client can match its candidate, and `path` is the canonical workspace-relative form
 * every other `files.*` call takes back. Paths outside the workspace never become a target: they
 * are refused, not reported as missing.
 */
export const FileTarget = z.object({
  requested: z.string(),
  /** Relative to the task's workspace, `/`-separated, symlinks resolved. */
  path: z.string(),
  /** The last path segment, for a row's label and a preview's alt text. */
  name: z.string(),
  kind: z.enum(["file", "directory"]),
  /** Bytes; 0 for a directory. */
  size: z.number().int().nonnegative(),
  /** `null` for anything this build does not preview inline. */
  media: FileMedia.nullable(),
  /** The media type of `media`, else `null`. */
  mime: z.string().nullable(),
  /** Whether `files.read` will serve it: a file, with a media kind, within `FILE_PREVIEW_LIMITS`. */
  previewable: z.boolean(),
});
export type FileTarget = z.infer<typeof FileTarget>;

/** One candidate of `files.resolve`: a target, or why it is not one. */
export const FileResolution = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), target: FileTarget }),
  /** Nothing at that path; the false positive a link renderer must leave as plain text. */
  z.object({ status: z.literal("missing"), requested: z.string() }),
  /** Real, but outside the task's workspace (a `..` path, an absolute path elsewhere, a symlink out). */
  z.object({ status: z.literal("outside"), requested: z.string() }),
]);
export type FileResolution = z.infer<typeof FileResolution>;

/** A previewable file's bytes, bounded by `FILE_PREVIEW_LIMITS` and base64 in the payload. */
export const FileBytes = z.object({
  path: z.string(),
  name: z.string(),
  media: FileMedia,
  mime: z.string(),
  size: z.number().int().nonnegative(),
  /** The file's bytes as base64; a stream or a range request stays out of this slice. */
  bytes: z.string(),
});
export type FileBytes = z.infer<typeof FileBytes>;

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
  /** The agent has no driver for the view, or a shell was asked to run as chat. */
  LAUNCH_VIEW_UNSUPPORTED: { data: z.object({ kind: SessionKind, view: SessionView }) },
  /** `[agents.<kind>].enabled = false`: the agent is not offered, so a new launch is refused. */
  AGENT_DISABLED: { data: z.object({ kind: AgentKind }) },
  /** An unexpected spawn failure; `message` is redacted against referenced environment values. */
  LAUNCH_FAILED: { data: z.object({ kind: SessionKind, message: z.string() }) },
};
/** Git refused or failed; `message` is git's own stderr, meant for the user. */
const gitFailed = { GIT_FAILED: { data: z.object({ message: z.string() }) } };
/**
 * Why a write from the Changes tab was refused before or instead of reaching git or the CLI. Every
 * one names what the user confirmed and what the server found, so the dialog can show both.
 */
const changesRefused = {
  /** The remote is no longer the one the user confirmed: a `insteadOf` rewrite or an edited config. */
  CHANGES_REMOTE_MISMATCH: {
    data: z.object({
      remote: z.string(),
      confirmed: z.string(),
      actual: z.string(),
    }),
  },
  /** No remote would take a push: no upstream, no `origin`, not exactly one remote. */
  CHANGES_NO_REMOTE: { data: z.object({ branch: z.string() }) },
  /** The workspace is on another branch than the one the user confirmed. */
  CHANGES_BRANCH_MISMATCH: {
    data: z.object({ confirmed: z.string(), actual: z.string().nullable() }),
  },
  /** Nothing is in the index, so a commit would fail with git's own sentence anyway. */
  CHANGES_NOTHING_STAGED: {},
  /** An empty or blank commit message; the message field keeps what the user typed. */
  CHANGES_EMPTY_MESSAGE: {},
  /** The remote does not have the branch yet, and creating a pull request would push as a side effect. */
  CHANGES_PUSH_REQUIRED: { data: z.object({ remote: z.string(), branch: z.string() }) },
  /** `gh` or `glab` is not on the server's PATH. */
  CHANGES_CLI_MISSING: { data: z.object({ command: z.string() }) },
  /** The host's CLI has no usable login for the request's host. */
  CHANGES_AUTH_REQUIRED: { data: z.object({ provider: IssueProvider }) },
  /** The CLI failed for another reason; `message` is a sentence without its output. */
  CHANGES_CLI_FAILED: { data: z.object({ provider: IssueProvider, message: z.string() }) },
  /** The CLI answered something Corral cannot read as a pull request. */
  CHANGES_RESPONSE_INVALID: { data: z.object({ provider: IssueProvider }) },
};
/**
 * Why chat is unavailable: `no-driver` — this build has no driver for the agent, so retrying
 * cannot help; `not-started` — the session's frontend is not running and can be started;
 * `exited` — it stopped and its last state is what the client already has.
 */
export const ChatUnavailableReason = z.enum(["no-driver", "not-started", "exited"]);
export type ChatUnavailableReason = z.infer<typeof ChatUnavailableReason>;

/**
 * Reading or opening a local path behind a chat link. The allow-list is the security boundary, so
 * a refusal says why (outside the workspace, missing, a directory, too large) instead of hiding as
 * a 404: the client shows the reason and leaves the text alone.
 */
const fileErrors = {
  /** The path resolves outside the task's workspace, directly or through a symlink. */
  FILE_OUTSIDE_WORKSPACE: { data: z.object({ path: z.string() }) },
  FILE_NOT_FOUND: { data: z.object({ path: z.string() }) },
  /** The target is a directory; Corral opens files, not folders. */
  FILE_IS_DIRECTORY: { data: z.object({ path: z.string() }) },
  /** Bigger than the inline preview bound; the file itself is fine, it is just not previewed. */
  FILE_TOO_LARGE: {
    data: z.object({ path: z.string(), size: z.number().int(), limit: z.number().int() }),
  },
  /** Not an image or video this build previews. */
  FILE_TYPE_UNSUPPORTED: { data: z.object({ path: z.string() }) },
  /** It exists but could not be read, e.g. permissions. */
  FILE_UNREADABLE: { data: z.object({ path: z.string() }) },
  /**
   * The path was replaced between the allow-list check and the read: a different inode, or a
   * symlink where the checked file was. Refused rather than followed, so a swap cannot serve
   * bytes the workspace check never saw.
   */
  FILE_CHANGED: { data: z.object({ path: z.string() }) },
  /** No `[editor] command`, `$VISUAL` or `$EDITOR` on the server; `reason` is a sentence. */
  EDITOR_UNSET: { data: z.object({ reason: z.string() }) },
  /** The configured editor is not an executable the server can run. */
  EDITOR_NOT_FOUND: { data: z.object({ command: z.string() }) },
};
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
  models: modelsContract,
  config: configContract,
  projects: {
    /**
     * Registers the git repository containing `path` (any directory inside it works). The server
     * trims it, expands a leading `~` with the server's home, refuses a relative path and stores
     * git's absolute main working tree.
     */
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
    /** Local and remote-tracking branches (`origin/x`) a new worktree can check out without a local branch-name conflict, for the create-task form. */
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
     * Starts a shell or an agent in the task's workspace, in a new terminal or, for `view: "chat"`,
     * as a chat session with a driver. The agent CLI is looked up on the server's `PATH`, unless
     * `[agents.<kind>].command` names an executable; a disabled agent is refused with
     * `AGENT_DISABLED` and a missing one fails with `AGENT_NOT_FOUND`.
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
          /** `terminal` when omitted; `chat` needs an agent with a chat driver. */
          view: SessionView.optional(),
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
    /**
     * Moves the session between its two views (design.md, decision 5): the live frontend is stopped
     * and its process awaited, then the other view starts on the same agent session id. The session
     * keeps its id, label and place in the task's tabs; the conversation is the agent's own and
     * survives, while the in-flight turn and pending requests do not — a working turn is aborted
     * first. A chat view needs an agent with a chat driver (otherwise `LAUNCH_VIEW_UNSUPPORTED`),
     * and never a shell. On a stopped session only the stored view changes, so its next start opens
     * there; a handoff whose second start fails leaves it stopped with `launchError` set.
     */
    setView: oc
      .errors({
        ...sessionNotFound,
        AGENT_NOT_FOUND: { data: z.object({ command: z.string() }) },
        ...launchRefused,
      })
      .input(
        z.object({
          id: SessionId,
          view: SessionView,
          /** The grid a terminal target opens with; a chat target ignores it, as `start` does. */
          size: TerminalSize,
        }),
      )
      .output(Session),
    /** Yields all sessions now and after every change. */
    watch: oc.output(eventIterator(z.array(Session))),
  },
  chat: {
    /**
     * What this server build can show as chat, and what each agent's driver can do (protocol 10). A
     * build fact, not a session's state, so a client asks once per connection (the list changes when
     * a driver lands). `kind` is the agent; the flags enable or disable the controls that would use
     * them, and `terminalView` says whether a terminal can be open beside the chat or only instead
     * of it (design.md, **Terminal and chat**).
     */
    capabilities: oc.output(z.object({ drivers: z.array(ChatDriverCapabilities) })),
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
  changes: {
    /**
     * Yields every task's changed files now and after the server learns a workspace may have
     * changed (a chat driver's tool call). Read-only: nothing here stages, commits or checks out.
     */
    watch: oc.output(eventIterator(z.array(TaskChanges))),
    /**
     * Recomputes one task's read model now: the base is the merge base with the project's default
     * branch for a worktree task, `HEAD` for a task in the main working tree, plus untracked files;
     * a base branch that is gone falls back to `HEAD` and says so in `base.fallback`.
     */
    files: oc
      .errors(taskNotFound)
      .input(z.object({ id: TaskId }))
      .output(TaskChanges),
    /**
     * One file's unified diff under the task's base, capped at 512 KiB and cut at a line boundary;
     * a binary file carries no text and its size instead.
     */
    diff: oc
      .errors({
        ...taskNotFound,
        ...gitFailed,
        CHANGES_FILE_UNKNOWN: { data: z.object({ path: z.string() }) },
      })
      .input(z.object({ taskId: TaskId, path: z.string().min(1) }))
      .output(ChangeDiff),
    /**
     * The branch, base, push remote and staged paths of one task: the read the commit, push and
     * pull-request controls open with, so their confirmations name a remote and a branch the
     * server can check against the repository when the write arrives.
     */
    finish: oc
      .errors({ ...taskNotFound, ...gitFailed })
      .input(z.object({ id: TaskId }))
      .output(ChangesFinish),
    /**
     * Stages or unstages exactly the paths the user selected, or every change with `all`. The only
     * caller-visible way into the index: nothing else in Corral writes it (`changes.*` reads never
     * do), and the answer is the new `finish` read so the controls move with it.
     */
    stage: oc
      .errors({ ...taskNotFound, ...gitFailed, ...changesRefused })
      .input(
        z.object({
          id: TaskId,
          /** `all` stages every change in the workspace; a list stages exactly those paths. */
          paths: z.union([
            z.literal("all"),
            z.array(z.string().min(1).max(FILE_PATH_MAX)).min(1).max(1000),
          ]),
          /** `false` takes the paths out of the index again. */
          staged: z.boolean(),
        }),
      )
      .output(ChangesFinish),
    /**
     * Commits what is staged, with the message the user typed. A blank message is refused, never
     * replaced by an empty one: writing a commit message is the user's, and this slice ships no
     * generator (C6 decision d).
     */
    commit: oc
      .errors({ ...taskNotFound, ...gitFailed, ...changesRefused })
      .input(z.object({ id: TaskId, message: z.string().max(MAX_COMMIT_MESSAGE) }))
      .output(
        z.object({
          /** Full commit id. */
          sha: z.string().min(1),
          shortSha: z.string().min(1),
          subject: z.string(),
          finish: ChangesFinish,
        }),
      ),
    /**
     * Pushes the checked-out branch to the remote the user confirmed. No force, no upstream is set,
     * and a remote whose URL is not the confirmed one is refused (`CHANGES_REMOTE_MISMATCH`), as is
     * a workspace that switched branches after the confirmation (`CHANGES_BRANCH_MISMATCH`).
     */
    push: oc
      .errors({ ...taskNotFound, ...gitFailed, ...changesRefused })
      .input(z.object({ id: TaskId, remote: ChangesRemote, branch: z.string().min(1) }))
      .output(
        z.object({
          remote: ChangesRemote,
          branch: z.string().min(1),
          commit: z.string().min(1),
          finish: ChangesFinish,
        }),
      ),
    /**
     * Opens a pull or merge request through the server host's own `gh` or `glab`, after checking
     * that the confirmed remote exists, still has the confirmed URL, and already has the branch: a
     * create never pushes (`gh` would, when the head branch is missing), so it is refused instead.
     */
    createPullRequest: oc
      .errors({ ...taskNotFound, ...gitFailed, ...changesRefused })
      .input(
        z.object({
          id: TaskId,
          provider: IssueProvider,
          remote: ChangesRemote,
          branch: z.string().min(1),
          base: z.string().min(1),
          title: z.string().min(1).max(MAX_PULL_REQUEST_TITLE),
          body: z.string().max(256 * 1024),
          draft: z.boolean().optional(),
        }),
      )
      .output(PullRequest),
    /**
     * The pull request linked to a task, or `null` when none is. `refresh` asks the CLI for the
     * current state (the client does that on focus and on its interval); a read that fails keeps
     * the link and answers `state: "unknown"` with the reason, never `closed`.
     */
    pullRequest: oc
      .errors({ ...taskNotFound })
      .input(z.object({ id: TaskId, refresh: z.boolean().optional() }))
      .output(PullRequest.nullable()),
  },
  files: {
    /**
     * Resolves path candidates of a chat message against the task's workspace, which is the only
     * root a link may reach (symlinks are resolved, so a link cannot leave it). A batch lookup is
     * a lookup, not a fetch: a path outside the workspace and a path that does not exist are both
     * answers per entry, so a renderer can leave that text plain instead of showing a dead link.
     */
    resolve: oc
      .errors({ ...taskNotFound, ...badRequest })
      .input(
        z.object({
          taskId: TaskId,
          /** Candidates as the message wrote them; at most a screenful of them per message. */
          paths: z.array(z.string().min(1).max(FILE_PATH_MAX)).max(FILE_RESOLVE_BATCH),
        }),
      )
      .output(z.object({ results: z.array(FileResolution) })),
    /**
     * Serves an image's or video's bytes for an inline preview. Bounded by `FILE_PREVIEW_LIMITS`
     * and base64 in one reply: there is no range request and no second HTTP route, so the bytes
     * travel over the already-authenticated channel like every other call.
     */
    read: oc
      .errors({ ...taskNotFound, ...badRequest, ...fileErrors })
      .input(z.object({ taskId: TaskId, path: z.string().min(1) }))
      .output(FileBytes),
    /**
     * Opens a workspace file in the user's editor: `[editor] command`, else `$VISUAL`, else
     * `$EDITOR`, run as a terminal in the task's workspace (a terminal editor needs a PTY). A
     * `{line}`/`{column}` placeholder carries the position the message named. The launch is
     * refused with `EDITOR_UNSET` when nothing is configured — the desktop OS opener is not a
     * fallback for a source file.
     */
    openEditor: oc
      .errors({ ...taskNotFound, ...badRequest, ...fileErrors })
      .input(
        z.object({
          taskId: TaskId,
          path: z.string().min(1),
          line: z.number().int().positive().optional(),
          column: z.number().int().positive().optional(),
          /** The grid the editor's terminal opens with; a GUI editor ignores it. */
          size: TerminalSize,
        }),
      )
      .output(z.object({ terminalId: TerminalId })),
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
