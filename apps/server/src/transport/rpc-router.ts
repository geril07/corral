import { contract } from "@corral/protocol/rpc";
import { implement } from "@orpc/server";
import type { ChatService } from "../chat/chat-service.ts";
import {
  ChatModelUnsupportedError,
  ChatReasoningUnsupportedError,
  ChatRequestUnknownError,
  ChatUnavailableError,
} from "../chat/chat-errors.ts";
import type { ConfigWatcher } from "../config/config-watcher.ts";
import { GitError } from "../git/git.ts";
import {
  InvalidIssueUrlError,
  IssueAuthRequiredError,
  IssueCliMissingError,
  IssueFetchFailedError,
  IssueFetchTimeoutError,
  IssueHostUntrustedError,
  IssueProviderRequiredError,
  IssueResponseInvalidError,
  IssueUnsupportedPortError,
} from "../issues/errors.ts";
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
  LaunchModelInvalidError,
  LaunchModelUnsupportedError,
  LaunchProfileChangedError,
  LaunchProfileKindMismatchError,
  LaunchProfileRevisionWithoutProfileError,
  LaunchProfileUnknownError,
  LaunchSpawnError,
  LaunchViewUnsupportedError,
  SessionNotFoundError,
} from "../sessions/errors.ts";
import { MissingEnvRefError, ReservedEnvRefError } from "../agents/launch-env.ts";
import type { SessionKind } from "@corral/protocol/rpc";
import type { SessionService } from "../sessions/session-service.ts";
import { BlankTaskTitleError, TaskNotFoundError, WorktreeDirtyError } from "../tasks/errors.ts";
import type { TaskService } from "../tasks/task-service.ts";
import type { TerminalRegistry } from "../terminals/terminal-registry.ts";

export interface RpcServices {
  config: ConfigWatcher;
  projects: ProjectService;
  tasks: TaskService;
  sessions: SessionService;
  chat: ChatService;
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

/** Maps the launch errors shared by start and restart; `undefined` lets anything else propagate. */
function launchError(
  error: unknown,
  errors: {
    LAUNCH_PROFILE_UNKNOWN: (options: { data: { id: string } }) => Error;
    LAUNCH_PROFILE_CHANGED: (options: { data: { id: string } }) => Error;
    LAUNCH_PROFILE_REVISION_UNSUPPORTED: (options?: Record<string, never>) => Error;
    LAUNCH_PROFILE_KIND_MISMATCH: (options: { data: { id: string; kind: SessionKind } }) => Error;
    LAUNCH_MODEL_UNSUPPORTED: (options: { data: { kind: SessionKind } }) => Error;
    LAUNCH_MODEL_INVALID: (options: { data: { kind: SessionKind } }) => Error;
    LAUNCH_ENV_MISSING: (options: { data: { profileId: string | null; name: string } }) => Error;
    LAUNCH_ENV_RESERVED: (options: { data: { name: string } }) => Error;
    LAUNCH_VIEW_UNSUPPORTED: (options: {
      data: { kind: SessionKind; view: "terminal" | "chat" };
    }) => Error;
    LAUNCH_FAILED: (options: { data: { kind: SessionKind; message: string } }) => Error;
  },
): Error | undefined {
  if (error instanceof LaunchProfileUnknownError)
    return errors.LAUNCH_PROFILE_UNKNOWN({ data: { id: error.id } });
  if (error instanceof LaunchProfileChangedError)
    return errors.LAUNCH_PROFILE_CHANGED({ data: { id: error.id } });
  if (error instanceof LaunchProfileRevisionWithoutProfileError)
    return errors.LAUNCH_PROFILE_REVISION_UNSUPPORTED();
  if (error instanceof LaunchProfileKindMismatchError)
    return errors.LAUNCH_PROFILE_KIND_MISMATCH({ data: { id: error.id, kind: error.kind } });
  if (error instanceof LaunchModelUnsupportedError)
    return errors.LAUNCH_MODEL_UNSUPPORTED({ data: { kind: error.kind } });
  if (error instanceof LaunchModelInvalidError)
    return errors.LAUNCH_MODEL_INVALID({ data: { kind: error.kind } });
  if (error instanceof MissingEnvRefError)
    return errors.LAUNCH_ENV_MISSING({
      data: { profileId: error.profileId, name: error.variable },
    });
  if (error instanceof ReservedEnvRefError)
    return errors.LAUNCH_ENV_RESERVED({ data: { name: error.variable } });
  if (error instanceof LaunchViewUnsupportedError)
    return errors.LAUNCH_VIEW_UNSUPPORTED({ data: { kind: error.kind, view: error.view } });
  if (error instanceof LaunchSpawnError)
    return errors.LAUNCH_FAILED({ data: { kind: error.kind, message: error.summary } });
  return undefined;
}

/**
 * Maps the chat driver's refusals to the typed errors of the `chat.*` contract. Each procedure
 * declares only its own codes, so a constructor that the caller's contract lacks stays undefined
 * and the error propagates instead (a driver bug, not a wire answer).
 */
function chatError(
  error: unknown,
  errors: {
    CHAT_UNAVAILABLE?: (options: {
      data: { message: string; reason: "no-driver" | "not-started" | "exited" };
    }) => Error;
    CHAT_REQUEST_UNKNOWN?: (options: { data: { requestId: string } }) => Error;
    CHAT_MODEL_UNSUPPORTED?: (options: {
      data: { model: { provider: string | null; id: string } };
    }) => Error;
    CHAT_REASONING_UNSUPPORTED?: (options: { data: { level: string } }) => Error;
  },
): Error | undefined {
  if (error instanceof ChatUnavailableError)
    return errors.CHAT_UNAVAILABLE?.({ data: { message: error.message, reason: error.reason } });
  if (error instanceof ChatRequestUnknownError)
    return errors.CHAT_REQUEST_UNKNOWN?.({ data: { requestId: error.requestId } });
  if (error instanceof ChatModelUnsupportedError)
    return errors.CHAT_MODEL_UNSUPPORTED?.({ data: { model: error.model } });
  if (error instanceof ChatReasoningUnsupportedError)
    return errors.CHAT_REASONING_UNSUPPORTED?.({ data: { level: error.level } });
  return undefined;
}

export function createRpcRouter({
  config,
  projects,
  tasks,
  sessions,
  chat,
  terminals,
}: RpcServices) {
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
      resolveIssue: os.projects.resolveIssue.handler(({ input, errors, signal }) =>
        translating(
          () =>
            projects.resolveIssue(
              input.projectId,
              { url: input.url, provider: input.provider },
              signal,
            ),
          (error) => {
            if (error instanceof ProjectNotFoundError)
              return errors.PROJECT_NOT_FOUND({ data: { id: error.id } });
            if (error instanceof InvalidIssueUrlError)
              return errors.ISSUE_URL_INVALID({ data: { message: error.message } });
            if (error instanceof IssueProviderRequiredError)
              return errors.ISSUE_PROVIDER_REQUIRED({ data: { host: error.host } });
            if (error instanceof IssueHostUntrustedError)
              return errors.ISSUE_HOST_UNTRUSTED({
                data: { provider: error.provider, host: error.host },
              });
            if (error instanceof IssueUnsupportedPortError)
              return errors.ISSUE_UNSUPPORTED_PORT({
                data: { provider: error.provider, host: error.host },
              });
            if (error instanceof IssueCliMissingError)
              return errors.ISSUE_CLI_MISSING({ data: { command: error.command } });
            if (error instanceof IssueAuthRequiredError)
              return errors.ISSUE_AUTH_REQUIRED({ data: { provider: error.provider } });
            if (error instanceof IssueFetchTimeoutError)
              return errors.ISSUE_FETCH_TIMEOUT({ data: { provider: error.provider } });
            if (error instanceof IssueResponseInvalidError)
              return errors.ISSUE_RESPONSE_INVALID({ data: { provider: error.provider } });
            if (error instanceof IssueFetchFailedError)
              return errors.ISSUE_FETCH_FAILED({
                data: { provider: error.provider, message: error.message },
              });
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
      rename: os.tasks.rename.handler(({ input, errors }) =>
        translating(
          () => tasks.rename(input.id, input.title),
          (error) => {
            if (error instanceof TaskNotFoundError)
              return errors.TASK_NOT_FOUND({ data: { id: error.id } });
            if (error instanceof BlankTaskTitleError)
              return errors.BAD_REQUEST({ data: { message: error.message } });
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
      markSeen: os.tasks.markSeen.handler(({ input, errors }) =>
        translating(
          () => tasks.markSeen(input.id),
          (error) => {
            if (error instanceof TaskNotFoundError)
              return errors.TASK_NOT_FOUND({ data: { id: error.id } });
            return undefined;
          },
        ),
      ),
      watch: os.tasks.watch.handler(({ signal }) => tasks.watch(signal)),
    },
    sessions: {
      start: os.sessions.start.handler(({ input, errors }) =>
        translating(
          () =>
            sessions.start(input.taskId, input.kind, input.size, {
              profileId: input.profileId,
              expectedProfileRevision: input.expectedProfileRevision,
              model: input.model,
              view: input.view,
            }),
          (error) => {
            if (error instanceof TaskNotFoundError)
              return errors.TASK_NOT_FOUND({ data: { id: error.id } });
            if (error instanceof AgentNotFoundError)
              return errors.AGENT_NOT_FOUND({ data: { command: error.command } });
            return launchError(error, errors);
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
            return launchError(error, errors);
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
      setLabel: os.sessions.setLabel.handler(({ input, errors }) =>
        translating(
          () => sessions.setLabel(input.id, input.label),
          (error) => {
            if (error instanceof SessionNotFoundError)
              return errors.SESSION_NOT_FOUND({ data: { id: error.id } });
            return undefined;
          },
        ),
      ),
      watch: os.sessions.watch.handler(({ signal }) => sessions.watch(signal)),
    },
    chat: {
      // The pi driver (B1). The build fact comes from the chat service, so this router never
      // decides by agent kind; a session without a live frontend gets `CHAT_UNAVAILABLE` with the
      // reason a client can act on, never an ended iterator (B0's contract).
      capabilities: os.chat.capabilities.handler(() => ({ drivers: chat.capabilities() })),
      watch: os.chat.watch.handler(({ input, errors, signal }) => {
        const subject = sessions.chatSubject(input.sessionId);
        if (!subject) throw errors.SESSION_NOT_FOUND({ data: { id: input.sessionId } });
        return translating(
          () => chat.watch(subject, input.after, signal),
          (error) => chatError(error, errors),
        );
      }),
      send: os.chat.send.handler(({ input, errors }) =>
        translating(
          () => {
            const subject = sessions.chatSubject(input.sessionId);
            if (!subject) throw new SessionNotFoundError(input.sessionId);
            return chat.send(subject, input.text, input.mode);
          },
          (error) =>
            error instanceof SessionNotFoundError
              ? errors.SESSION_NOT_FOUND({ data: { id: error.id } })
              : chatError(error, errors),
        ),
      ),
      abort: os.chat.abort.handler(({ input, errors }) =>
        translating(
          async () => {
            const subject = sessions.chatSubject(input.sessionId);
            if (!subject) throw new SessionNotFoundError(input.sessionId);
            await chat.abort(subject);
          },
          (error) =>
            error instanceof SessionNotFoundError
              ? errors.SESSION_NOT_FOUND({ data: { id: error.id } })
              : chatError(error, errors),
        ),
      ),
      respond: os.chat.respond.handler(({ input, errors }) =>
        translating(
          () => {
            const subject = sessions.chatSubject(input.sessionId);
            if (!subject) throw new SessionNotFoundError(input.sessionId);
            chat.respond(subject, input.requestId, input.value);
          },
          (error) =>
            error instanceof SessionNotFoundError
              ? errors.SESSION_NOT_FOUND({ data: { id: error.id } })
              : chatError(error, errors),
        ),
      ),
      setModel: os.chat.setModel.handler(({ input, errors }) =>
        translating(
          async () => {
            const subject = sessions.chatSubject(input.sessionId);
            if (!subject) throw new SessionNotFoundError(input.sessionId);
            await chat.setModel(subject, input.model);
          },
          (error) =>
            error instanceof SessionNotFoundError
              ? errors.SESSION_NOT_FOUND({ data: { id: error.id } })
              : chatError(error, errors),
        ),
      ),
      setReasoning: os.chat.setReasoning.handler(({ input, errors }) =>
        translating(
          async () => {
            const subject = sessions.chatSubject(input.sessionId);
            if (!subject) throw new SessionNotFoundError(input.sessionId);
            await chat.setReasoning(subject, input.level);
          },
          (error) =>
            error instanceof SessionNotFoundError
              ? errors.SESSION_NOT_FOUND({ data: { id: error.id } })
              : chatError(error, errors),
        ),
      ),
    },
    terminals: {
      list: os.terminals.list.handler(() => terminals.list()),
      create: os.terminals.create.handler(({ input }) => terminals.create(input)),
      close: os.terminals.close.handler(async ({ input, errors }) => {
        if (!(await sessions.closeTerminal(input.id)))
          throw errors.NOT_FOUND({ data: { id: input.id } });
      }),
      setLabel: os.terminals.setLabel.handler(({ input, errors }) => {
        if (terminals.get(input.id)?.info.sessionId) throw errors.NOT_A_LOOSE_TERMINAL();
        const renamed = terminals.setLabel(input.id, input.label);
        if (!renamed) throw errors.NOT_FOUND({ data: { id: input.id } });
        return renamed;
      }),
      watch: os.terminals.watch.handler(({ signal }) => terminals.watch(signal)),
    },
  });
}
