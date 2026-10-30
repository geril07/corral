import type { Backoff, CreateSocket } from "./reconnecting-socket.ts";
import { createProjectsStore, type ProjectsStore } from "./projects-store.ts";
import { connectRpc, type RpcConnection } from "./rpc-connection.ts";
import { createTasksStore, type TasksStore } from "./tasks-store.ts";
import { createTerminalsStore, type TerminalsStore } from "./terminals-store.ts";
import { TerminalStream, type TerminalSurface } from "./terminal-stream.ts";

export interface CorralClientOptions {
  serverUrl: string;
  backoff?: Backoff;
  createSocket?: CreateSocket;
}

export interface CorralClient {
  readonly connection: RpcConnection;
  readonly projects: ProjectsStore;
  readonly tasks: TasksStore;
  readonly terminals: TerminalsStore;
  /** Shows the terminal on `surface` until the caller closes the returned stream. */
  attach(terminalId: string, surface: TerminalSurface): TerminalStream;
  close(): void;
}

export function createCorralClient(options: CorralClientOptions): CorralClient {
  const connection = connectRpc(options);
  const projects = createProjectsStore(connection);
  const tasks = createTasksStore(connection);
  const terminals = createTerminalsStore(connection);
  return {
    connection,
    projects,
    tasks,
    terminals,
    attach: (terminalId, surface) => new TerminalStream({ ...options, terminalId, surface }),
    close: () => {
      projects.close();
      tasks.close();
      terminals.close();
      connection.close();
    },
  };
}
