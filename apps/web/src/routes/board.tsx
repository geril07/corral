import { createFileRoute } from "@tanstack/react-router";
import { BoardScreen } from "../modules/board/index.ts";
import { validateWorkspaceSearch } from "../modules/workspace/index.ts";

export const Route = createFileRoute("/board")({
  validateSearch: validateWorkspaceSearch,
  component: BoardRoute,
});

function BoardRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <BoardScreen
      onClose={() => void navigate({ to: "/", search, replace: true })}
      onJump={(next) => void navigate({ to: "/", search: next, replace: true })}
    />
  );
}
