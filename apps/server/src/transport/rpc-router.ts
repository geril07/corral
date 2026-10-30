import { contract } from "@corral/protocol/rpc";
import { implement } from "@orpc/server";
import { GitError } from "../git/git.ts";
import {
  HasLiveTerminalsError,
  NotAGitRepositoryError,
  ProjectExistsError,
  ProjectNotFoundError,
} from "../projects/errors.ts";
import type { ProjectService } from "../projects/project-service.ts";
import { TaskNotFoundError, WorktreeDirtyError } from "../tasks/errors.ts";
import type { TaskService } from "../tasks/task-service.ts";
import { createTerminal, InvalidTerminalRequestError } from "../terminals/create-terminal.ts";
import type { TerminalRegistry } from "../terminals/terminal-registry.ts";

export interface RpcServices {
  projects: ProjectService;
  tasks: TaskService;
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

export function createRpcRouter({ projects, tasks, terminals }: RpcServices) {
  const os = implement(contract);
  return os.router({
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
    terminals: {
      list: os.terminals.list.handler(() => terminals.list()),
      create: os.terminals.create.handler(({ input, errors }) =>
        translating(
          () => createTerminal(terminals, (id) => tasks.get(id), input),
          (error) => {
            if (error instanceof TaskNotFoundError)
              return errors.TASK_NOT_FOUND({ data: { id: error.id } });
            if (error instanceof InvalidTerminalRequestError)
              return errors.BAD_REQUEST({ data: { message: error.message } });
            return undefined;
          },
        ),
      ),
      close: os.terminals.close.handler(({ input, errors }) => {
        if (!terminals.close(input.id)) throw errors.NOT_FOUND({ data: { id: input.id } });
      }),
      watch: os.terminals.watch.handler(({ signal }) => terminals.watch(signal)),
    },
  });
}
