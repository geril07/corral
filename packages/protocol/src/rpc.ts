import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";

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

export const TerminalInfo = z.object({
  id: TerminalId,
  /** The task the terminal works in; `null` for a terminal outside any task. */
  taskId: TaskId.nullable(),
  /** Executable and arguments the PTY runs. */
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  size: TerminalSize,
  /** Set once the process exits. An exited terminal stays listed until it is closed. */
  exit: TerminalExit.nullable(),
});
export type TerminalInfo = z.infer<typeof TerminalInfo>;

export const CreateTerminalInput = z.object({
  /** Runs in the task's working directory; `cwd` must then be omitted. */
  taskId: TaskId.optional(),
  /** Defaults to the user's login shell (`$SHELL`). */
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  /** Defaults to the task's working directory, else the user's home directory. */
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
  /** Set by the user; derived agent status arrives with agent sessions. */
  state: z.enum(["active", "archived"]),
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

const terminalNotFound = { NOT_FOUND: { data: z.object({ id: TerminalId }) } };
const projectNotFound = { PROJECT_NOT_FOUND: { data: z.object({ id: ProjectId }) } };
const taskNotFound = { TASK_NOT_FOUND: { data: z.object({ id: TaskId }) } };
/** Git refused or failed; `message` is git's own stderr, meant for the user. */
const gitFailed = { GIT_FAILED: { data: z.object({ message: z.string() }) } };

export const contract = {
  projects: {
    /** Registers the git repository containing `path` (any directory inside it works). */
    add: oc
      .errors({
        NOT_A_GIT_REPOSITORY: { data: z.object({ path: z.string() }) },
        PROJECT_EXISTS: { data: z.object({ id: ProjectId }) },
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
    setState: oc
      .errors(taskNotFound)
      .input(z.object({ id: TaskId, state: Task.shape.state }))
      .output(Task),
    /**
     * Closes the task's terminals, removes a worktree the task owns and forgets the task. The
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
  terminals: {
    list: oc.output(z.array(TerminalInfo)),
    create: oc
      .errors({ ...taskNotFound, BAD_REQUEST: { data: z.object({ message: z.string() }) } })
      .input(CreateTerminalInput)
      .output(TerminalInfo),
    /** Kills the process if it still runs and forgets the terminal. */
    close: oc
      .errors(terminalNotFound)
      .input(z.object({ id: TerminalId }))
      .output(z.void()),
    /** Yields the full list now and again after every change (create, exit, resize, close). */
    watch: oc.output(eventIterator(z.array(TerminalInfo))),
  },
};
export type Contract = typeof contract;
