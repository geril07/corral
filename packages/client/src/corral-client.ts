import { createModelPreferencesStore } from "./model-preferences-store.ts";
import type { SessionId } from "@corral/protocol/rpc";
import type { ServerTarget } from "@corral/protocol/server-target";
import {
  createChatCapabilitiesStore,
  type ChatCapabilitiesStore,
} from "./chat-capabilities-store.ts";
import { createChatStore, type ChatStore } from "./chat-store.ts";
import { createChangesStore, type ChangesStore } from "./changes-store.ts";
import type { Backoff, CreateSocket } from "./reconnecting-socket.ts";
import { createConfigStore, type ConfigStore } from "./config-store.ts";
import { createProjectsStore, type ProjectsStore } from "./projects-store.ts";
import { connectRpc, type RpcConnection } from "./rpc-connection.ts";
import { createSessionsStore, type SessionsStore } from "./sessions-store.ts";
import { createTasksStore, type TasksStore } from "./tasks-store.ts";
import { createTerminalsStore, type TerminalsStore } from "./terminals-store.ts";
import { TerminalStream, type TerminalSurface } from "./terminal-stream.ts";

export interface CorralClientOptions {
  server: ServerTarget;
  /** Re-read before each reconnect, so a restarted server's new capability is picked up. */
  refreshServer?: (() => Promise<ServerTarget | undefined>) | undefined;
  backoff?: Backoff;
  createSocket?: CreateSocket;
}

export interface CorralClient {
  /** The endpoint this client was created with, for the surface that names it. */
  readonly server: ServerTarget;
  readonly connection: RpcConnection;
  readonly config: ConfigStore;
  readonly modelPreferences: ReturnType<typeof createModelPreferencesStore>;
  readonly projects: ProjectsStore;
  readonly tasks: TasksStore;
  readonly sessions: SessionsStore;
  readonly terminals: TerminalsStore;
  /** Which agents this server can show as chat, asked once per connection. */
  readonly chatCapabilities: ChatCapabilitiesStore;
  /** Each task's changed files, for the Changes tab, the task header and the sidebar rows. */
  readonly changes: ChangesStore;
  /** Shows the terminal on `surface` until the caller closes the returned stream. */
  attach(terminalId: string, surface: TerminalSurface): TerminalStream;
  /**
   * Retry the RPC connection and every attached terminal now, with the target the next attempt
   * reads. The one recovery entry point: a refused socket is separate from the RPC socket.
   */
  recover(): void;
  /** Follows one session's chat until the caller closes the returned store. */
  openChat(sessionId: SessionId): ChatStore;
  close(): void;
}

export function createCorralClient(options: CorralClientOptions): CorralClient {
  const connection = connectRpc(options);
  const streams = new Set<TerminalStream>();
  const config = createConfigStore(connection);
  const modelPreferences = createModelPreferencesStore(connection);
  const projects = createProjectsStore(connection);
  const tasks = createTasksStore(connection);
  const sessions = createSessionsStore(connection);
  const terminals = createTerminalsStore(connection);
  const chatCapabilities = createChatCapabilitiesStore({
    state: connection.state,
    capabilities: () => connection.api.chat.capabilities(),
  });
  const changes = createChangesStore({
    state: connection.state,
    watch: () => connection.api.changes.watch(),
    files: (input) => connection.api.changes.files(input),
    diff: (input) => connection.api.changes.diff(input),
  });
  return {
    server: options.server,
    connection,
    config,
    modelPreferences,
    projects,
    tasks,
    sessions,
    terminals,
    chatCapabilities,
    changes,
    attach: (terminalId, surface) => {
      let stream!: TerminalStream;
      stream = new TerminalStream({
        ...options,
        terminalId,
        surface,
        onClosed: () => streams.delete(stream),
      });
      streams.add(stream);
      return stream;
    },
    recover: () => {
      connection.retry();
      for (const stream of streams) stream.retry();
    },
    openChat: (sessionId) =>
      createChatStore(
        {
          state: connection.state,
          watch: (input) => connection.api.chat.watch(input),
        },
        sessionId,
      ),
    close: () => {
      for (const stream of streams) stream.close();
      config.close();
      modelPreferences.close();
      projects.close();
      tasks.close();
      sessions.close();
      terminals.close();
      chatCapabilities.close();
      changes.close();
      connection.close();
    },
  };
}
