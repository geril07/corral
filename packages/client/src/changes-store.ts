import type { ChangeDiff, TaskChanges } from "@corral/protocol/rpc";
import type { RpcConnection } from "./rpc-connection.ts";
import { Store, type ReadableStore } from "./store.ts";

export interface ChangesState {
  /** False until the server's first list arrives; until then the tab shows skeletons. */
  loaded: boolean;
  /** Each task's last read model, by task id; a task missing here has nothing read yet. */
  byTask: ReadonlyMap<string, TaskChanges>;
  /**
   * The server refused `changes.watch`: a daemon from before this procedure existed has no
   * changes read model. The tab says so instead of showing an empty task as if it were clean.
   */
  failed: boolean;
}

export interface ChangesStore extends ReadableStore<ChangesState> {
  /** Recomputed one task now: a tab becoming current, or a window regaining focus. */
  refresh(taskId: string): Promise<void>;
  /** One file's unified diff under the task's current base. */
  diff(taskId: string, path: string): Promise<ChangeDiff>;
  close(): void;
}

/**
 * Follows `changes.watch` (one read model per task, recomputed by the server when an agent's tool
 * call may have touched a workspace) and keeps the snapshot of each task by id. `refresh` is the
 * pull the watch cannot cover: an edit made outside Corral; it merges its answer in so the sidebar
 * and the header counts move with the tab.
 */
export function createChangesStore(connection: RpcConnection): ChangesStore {
  const store = new Store<ChangesState>({ loaded: false, byTask: new Map(), failed: false });
  let watching: object | undefined;

  const merge = (
    snapshots: readonly TaskChanges[],
    options: { loaded: boolean; failed: boolean },
  ) => {
    store.set({
      loaded: options.loaded,
      failed: options.failed,
      byTask: new Map(snapshots.map((snapshot) => [snapshot.taskId, snapshot])),
    });
  };

  /** One refreshed task in place of its entry; every other entry stays as the watch left it. */
  const mergeOne = (snapshot: TaskChanges) => {
    const current = store.getSnapshot();
    const byTask = new Map(current.byTask);
    byTask.set(snapshot.taskId, snapshot);
    store.set({ loaded: true, failed: current.failed, byTask });
  };

  async function follow(token: object) {
    try {
      for await (const snapshots of await connection.api.changes.watch()) {
        if (watching !== token) return;
        merge(snapshots, { loaded: true, failed: false });
      }
    } catch (error) {
      // A server without `changes.*` is a protocol-10 daemon from before C4; anything else is a
      // dropped socket, which the next connection restarts. Neither is worth a console error loop.
      if (watching !== token) return;
      if (isUnknownProcedure(error)) store.set({ loaded: true, byTask: new Map(), failed: true });
      else console.error("changes.watch failed", error);
    }
  }

  const sync = () => {
    const connected = connection.state.getSnapshot().status === "connected";
    if (connected && watching === undefined) {
      watching = {};
      void follow(watching);
    } else if (!connected) {
      watching = undefined;
    }
  };
  const unsubscribe = connection.state.subscribe(sync);
  sync();

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,
    refresh: async (taskId) => {
      mergeOne(await connection.api.changes.files({ id: taskId }));
    },
    diff: (taskId, path) => connection.api.changes.diff({ taskId, path }),
    close: () => {
      unsubscribe();
      watching = undefined;
    },
  };
}

/** oRPC answers an unknown procedure with `NOT_FOUND`-shaped text, not a typed contract error. */
function isUnknownProcedure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|unknown procedure|no procedure/i.test(message);
}
