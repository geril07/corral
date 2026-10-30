import { createHashHistory, createRouter, type RouterHistory } from "@tanstack/react-router";
import { routeTree } from "../routeTree.gen.ts";
import { parseRouteSearch } from "./router-search.ts";

/** Hash history: the desktop app loads the build from a file:// URL. */
export function createAppRouter(history?: RouterHistory) {
  const documentSearch =
    history === undefined && typeof window !== "undefined" ? window.location.search : "";
  return createRouter({
    routeTree,
    history: history ?? createHashHistory(),
    defaultPreload: false,
    parseSearch: (search) => parseRouteSearch(search, documentSearch),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
