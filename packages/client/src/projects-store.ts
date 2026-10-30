import type { Project } from "@corral/protocol/rpc";
import type { RpcConnection } from "./rpc-connection.ts";
import { createWatchStore, type WatchStore } from "./watch-store.ts";

export interface ProjectsSnapshot {
  /** False until the server has sent the list once. */
  loaded: boolean;
  /** The last list received; kept while disconnected, replaced when the connection returns. */
  projects: readonly Project[];
}

export type ProjectsStore = WatchStore<ProjectsSnapshot>;

export function createProjectsStore(connection: RpcConnection): ProjectsStore {
  return createWatchStore<Project, ProjectsSnapshot>(connection, {
    name: "projects.watch",
    initial: { loaded: false, projects: [] },
    watch: (rpc) => rpc.api.projects.watch(),
    toSnapshot: (projects) => ({ loaded: true, projects }),
  });
}
