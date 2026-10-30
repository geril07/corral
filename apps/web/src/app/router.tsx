import { createHashHistory, createRouter, type RouterHistory } from "@tanstack/react-router";
import { routeTree } from "../routeTree.gen.ts";

/** Hash history: the desktop app loads the build from a file:// URL. */
export function createAppRouter(history: RouterHistory = createHashHistory()) {
  return createRouter({
    routeTree,
    history,
    defaultPreload: false,
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
