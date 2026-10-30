import { createFileRoute } from "@tanstack/react-router";
import { validateWorkspaceSearch, WorkspaceScreen } from "../modules/workspace/index.ts";

export const Route = createFileRoute("/")({
  validateSearch: validateWorkspaceSearch,
  component: WorkspaceRoute,
});

function WorkspaceRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <WorkspaceScreen
      search={search}
      onChange={(next) => void navigate({ to: "/", search: next, replace: true })}
      onOpenBoard={(next) => void navigate({ to: "/board", search: next })}
      onOpenSettings={(next) => void navigate({ to: "/settings", search: next })}
    />
  );
}
