import { createFileRoute, Outlet, useLocation } from "@tanstack/react-router";
import { VisualWorkspace } from "../modules/shell/index.ts";
import { NO_TASK, validateWorkspaceSearch } from "../modules/workspace/index.ts";

export const Route = createFileRoute("/_workspace")({
  validateSearch: validateWorkspaceSearch,
  component: WorkspaceRoute,
});

/** A pathless parent keeps the shell mounted underneath the board and /settings. */
function WorkspaceRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const active = useLocation({
    select: (location) => location.pathname !== "/settings" && location.pathname !== "/board",
  });
  const selectedTaskId =
    search.task === undefined ? undefined : search.task === NO_TASK ? null : search.task;
  return (
    <>
      {/* The same inert layer the old workspace used: a full-screen route covers the shell, while
          the shell stays mounted and keeps its state. */}
      <div className="visual-route-fill" inert={!active} aria-hidden={!active || undefined}>
        <VisualWorkspace
          selectedTaskId={selectedTaskId}
          onSelectTask={(id) =>
            void navigate({ to: "/", search: { ...search, task: id }, replace: true })
          }
        />
      </div>
      <Outlet />
    </>
  );
}
