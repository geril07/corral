import type { ServerTarget } from "@corral/protocol/server-target";
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
  readonly connection: RpcConnection;
  readonly config: ConfigStore;
  readonly projects: ProjectsStore;
  readonly tasks: TasksStore;
  readonly sessions: SessionsStore;
  readonly terminals: TerminalsStore;
  /** Shows the terminal on `surface` until the caller closes the returned stream. */
  attach(terminalId: string, surface: TerminalSurface): TerminalStream;
  close(): void;
}

export function createCorralClient(options: CorralClientOptions): CorralClient {
  const connection = connectRpc(options);
  const config = createConfigStore(connection);
  const projects = createProjectsStore(connection);
  const tasks = createTasksStore(connection);
  const sessions = createSessionsStore(connection);
  const terminals = createTerminalsStore(connection);
  return {
    connection,
    config,
    projects,
    tasks,
    sessions,
    terminals,
    attach: (terminalId, surface) => new TerminalStream({ ...options, terminalId, surface }),
    close: () => {
      config.close();
      projects.close();
      tasks.close();
      sessions.close();
      terminals.close();
      connection.close();
    },
  };
}
