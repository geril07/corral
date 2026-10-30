import { contract } from "@corral/protocol/rpc";
import { implement } from "@orpc/server";
import type { ConfigWatcher } from "../config/config-watcher.ts";
import { GitError } from "../git/git.ts";
import {
  HasLiveTerminalsError,
  NotAGitRepositoryError,
  ProjectExistsError,
  ProjectNotFoundError,
} from "../projects/errors.ts";
import type { ProjectService } from "../projects/project-service.ts";
import {
  AgentNotFoundError,
  AlreadyRunningError,
  SessionNotFoundError,
} from "../sessions/errors.ts";
import type { SessionService } from "../sessions/session-service.ts";
import { TaskNotFoundError, WorktreeDirtyError } from "../tasks/errors.ts";
import type { TaskService } from "../tasks/task-service.ts";
import type { TerminalRegistry } from "../terminals/terminal-registry.ts";

export interface RpcServices {
  config: ConfigWatcher;
  projects: ProjectService;
  tasks: TaskService;
  sessions: SessionService;
  terminals: TerminalRegistry;
}

/** Runs `run`; a domain error becomes the typed RPC error `translate` returns for it, anything else propagates. */
async function translating<T>(
  run: () => T | Promise<T>,
  translate: (error: unknown) => Error | undefined,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw translate(error) ?? error;
  }
}

export function createRpcRouter({ config, projects, tasks, sessions, terminals }: RpcServices) {
  const os = implement(contract);
  return os.router({
    config: {
      watch: os.config.watch.handler(({ signal }) => config.watch(signal)),
    },
    projects: {
      add: os.projects.add.handler(({ input, errors }) =>
        translating(
          () => projects.add(input.path),
          (error) => {
            if (error instanceof NotAGitRepositoryError)
              return errors.NOT_A_GIT_REPOSITORY({ data: { path: error.path } });
            if (error instanceof ProjectExistsError)
              return errors.PROJECT_EXISTS({ data: { id: error.id } });
            if (error instanceof GitError)
              return errors.GIT_FAILED({ data: { message: error.message } });
            return undefined;
          },
        ),
      ),
      remove: os.projects.remove.handler(({ input, errors }) =>
        translating(
          () => projects.remove(input.id),
          (error) => {
            if (error instanceof ProjectNotFoundError)
              return errors.PROJECT_NOT_FOUND({ data: { id: error.id } });
            if (error instanceof HasLiveTerminalsError) return errors.HAS_LIVE_TERMINALS();
            return undefined;
          },
        ),
      ),
      branches: os.projects.branches.handler(({ input, errors }) =>
        translating(
          () => projects.branches(input.id),
          (error) => {
            if (error instanceof ProjectNotFoundError)
              return errors.PROJECT_NOT_FOUND({ data: { id: error.id } });
            if (error instanceof GitError)
              return errors.GIT_FAILED({ data: { message: error.message } });
            return undefined;
          },
        ),
      ),
      watch: os.projects.watch.handler(({ signal }) => projects.watch(signal)),
    },
    tasks: {
      create: os.tasks.create.handler(({ input, errors }) =>
        translating(
          () => tasks.create(input),
          (error) => {
            if (error instanceof ProjectNotFoundError)
              return errors.PROJECT_NOT_FOUND({ data: { id: error.id } });
            if (error instanceof GitError)
              return errors.GIT_FAILED({ data: { message: error.message } });
            return undefined;
          },
        ),
      ),
      setState: os.tasks.setState.handler(({ input, errors }) =>
        translating(
          () => tasks.setState(input.id, input.state),
          (error) => {
            if (error instanceof TaskNotFoundError)
              return errors.TASK_NOT_FOUND({ data: { id: error.id } });
            return undefined;
          },
        ),
      ),
      remove: os.tasks.remove.handler(({ input, errors }) =>
        translating(
          () => tasks.remove(input.id, input.force ?? false),
          (error) => {
            if (error instanceof TaskNotFoundError)
              return errors.TASK_NOT_FOUND({ data: { id: error.id } });
            if (error instanceof WorktreeDirtyError)
              return errors.WORKTREE_DIRTY({ data: { files: error.files } });
            if (error instanceof GitError)
              return errors.GIT_FAILED({ data: { message: error.message } });
            return undefined;
          },
        ),
      ),
      watch: os.tasks.watch.handler(({ signal }) => tasks.watch(signal)),
    },
    sessions: {
      start: os.sessions.start.handler(({ input, errors }) =>
        translating(
          () => sessions.start(input.taskId, input.kind, input.size),
          (error) => {
            if (error instanceof TaskNotFoundError)
              return errors.TASK_NOT_FOUND({ data: { id: error.id } });
            if (error instanceof AgentNotFoundError)
              return errors.AGENT_NOT_FOUND({ data: { command: error.command } });
            return undefined;
          },
        ),
      ),
      restart: os.sessions.restart.handler(({ input, errors }) =>
        translating(
          () => sessions.restart(input.id, input.size),
          (error) => {
            if (error instanceof SessionNotFoundError)
              return errors.SESSION_NOT_FOUND({ data: { id: error.id } });
            if (error instanceof AlreadyRunningError) return errors.ALREADY_RUNNING();
            if (error instanceof AgentNotFoundError)
              return errors.AGENT_NOT_FOUND({ data: { command: error.command } });
            return undefined;
          },
        ),
      ),
      stop: os.sessions.stop.handler(({ input, errors }) =>
        translating(
          () => sessions.stop(input.id),
          (error) => {
            if (error instanceof SessionNotFoundError)
              return errors.SESSION_NOT_FOUND({ data: { id: error.id } });
            return undefined;
          },
        ),
      ),
      remove: os.sessions.remove.handler(({ input, errors }) =>
        translating(
          () => sessions.remove(input.id),
          (error) => {
            if (error instanceof SessionNotFoundError)
              return errors.SESSION_NOT_FOUND({ data: { id: error.id } });
            return undefined;
          },
        ),
      ),
      watch: os.sessions.watch.handler(({ signal }) => sessions.watch(signal)),
    },
    terminals: {
      list: os.terminals.list.handler(() => terminals.list()),
      create: os.terminals.create.handler(({ input }) => terminals.create(input)),
      close: os.terminals.close.handler(async ({ input, errors }) => {
        if (!(await sessions.closeTerminal(input.id)))
          throw errors.NOT_FOUND({ data: { id: input.id } });
      }),
      watch: os.terminals.watch.handler(({ signal }) => terminals.watch(signal)),
    },
  });
}
