import type { Task } from "@corral/protocol/rpc";
import type { RpcConnection } from "./rpc-connection.ts";
import { createWatchStore, type WatchStore } from "./watch-store.ts";

export interface TasksSnapshot {
  /** False until the server has sent the list once. */
  loaded: boolean;
  /** Tasks of every project; the last list received, kept while disconnected. */
  tasks: readonly Task[];
}

export type TasksStore = WatchStore<TasksSnapshot>;

export function createTasksStore(connection: RpcConnection): TasksStore {
  return createWatchStore<Task, TasksSnapshot>(connection, {
    name: "tasks.watch",
    initial: { loaded: false, tasks: [] },
    watch: (rpc) => rpc.api.tasks.watch(),
    toSnapshot: (tasks) => ({ loaded: true, tasks }),
  });
}
