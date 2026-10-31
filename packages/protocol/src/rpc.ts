import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { AgentKind, EnvRef, configContract } from "./config.ts";
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

/**
 * A unit of work in a project. Its workspace is either its own git worktree on its own branch
 * (the default), or the project's main working tree.
 */
export const Task = z.object({
  id: TaskId,
  projectId: ProjectId,
  title: z.string().min(1),
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
  /** Epoch milliseconds. */
  createdAt: z.number(),
});
export type Task = z.infer<typeof Task>;

export const CreateTaskInput = z.object({
  projectId: ProjectId,
  title: z.string().trim().min(1),
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
});
export type CreateTaskInput = z.infer<typeof CreateTaskInput>;

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

const terminalNotFound = { NOT_FOUND: { data: z.object({ id: TerminalId }) } };
const projectNotFound = { PROJECT_NOT_FOUND: { data: z.object({ id: ProjectId }) } };
const taskNotFound = { TASK_NOT_FOUND: { data: z.object({ id: TaskId }) } };
const sessionNotFound = { SESSION_NOT_FOUND: { data: z.object({ id: SessionId }) } };
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
  terminals: {
    list: oc.output(z.array(TerminalInfo)),
    create: oc
      .errors({ BAD_REQUEST: { data: z.object({ message: z.string() }) } })
      .input(CreateTerminalInput)
      .output(TerminalInfo),
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
