import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import { validateWorkspaceSearch, WorkspaceScreen } from "../modules/workspace/index.ts";

export const Route = createFileRoute("/_workspace")({
  validateSearch: validateWorkspaceSearch,
  component: WorkspaceRoute,
});

/** A pathless parent keeps sessions, drafts and scroll mounted underneath /settings. */
function WorkspaceRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const active = useLocation({ select: (location) => location.pathname !== "/settings" });
  return (
    <>
      <WorkspaceScreen
        search={search}
        active={active}
        onChange={(next) => void navigate({ to: "/", search: next, replace: true })}
        onOpenBoard={(next) => void navigate({ to: "/board", search: next })}
        onOpenSettings={(next) => void navigate({ to: "/settings", search: next })}
      />
      <Outlet />
    </>
  );
}
