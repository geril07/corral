import { createFileRoute } from "@tanstack/react-router";
import { SettingsScreen } from "../modules/settings/index.ts";
import { validateWorkspaceSearch } from "../modules/workspace/index.ts";

export const Route = createFileRoute("/settings")({
  validateSearch: validateWorkspaceSearch,
  component: SettingsRoute,
});

function SettingsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return <SettingsScreen onClose={() => void navigate({ to: "/", search, replace: true })} />;
}
