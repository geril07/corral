import { createFileRoute } from "@tanstack/react-router";
import { useTaskFinalFocus } from "../common/ui/index.ts";
import { BoardScreen } from "../modules/board/index.ts";
import { validateWorkspaceSearch } from "../modules/workspace/index.ts";

export const Route = createFileRoute("/_workspace/board")({
  validateSearch: validateWorkspaceSearch,
  component: BoardRoute,
});

function BoardRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  // The board is a layer over the mounted workspace, so its close returns the keyboard the same
  // way a route dialog does instead of relying on the workspace remounting.
  const finalFocus = useTaskFinalFocus();
  return (
    <BoardScreen
      onClose={() => {
        void navigate({ to: "/", search, replace: true });
        finalFocus()?.focus();
      }}
      onJump={(next) => {
        void navigate({ to: "/", search: next, replace: true });
        finalFocus()?.focus();
      }}
    />
  );
}
