import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import { validateWorkspaceSearch, WorkspaceScreen } from "../modules/workspace/index.ts";

export const Route = createFileRoute("/_workspace")({
  validateSearch: validateWorkspaceSearch,
  component: WorkspaceRoute,
});

/** A pathless parent keeps sessions, drafts and scroll mounted underneath the board and /settings. */
function WorkspaceRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const active = useLocation({
    select: (location) => location.pathname !== "/settings" && location.pathname !== "/board",
  });
  return (
    <>
      {/*
       * A full-screen layer covers the workspace, not a dialog over it: inert keeps xterm's
       * focus calls and Tab out of the covered tree, and aria-hidden keeps it out of the tree AT
       * reads. The layer itself is the Outlet, outside this boundary.
       */}
      <div inert={!active} aria-hidden={!active || undefined}>
        <WorkspaceScreen
          search={search}
          active={active}
          onChange={(next) => void navigate({ to: "/", search: next, replace: true })}
          onOpenBoard={(next) => void navigate({ to: "/board", search: next })}
          onOpenSettings={(next) => void navigate({ to: "/settings", search: next })}
        />
      </div>
      <Outlet />
    </>
  );
}
