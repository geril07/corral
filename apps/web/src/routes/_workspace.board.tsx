import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
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
  const finalFocusRef = useRef(finalFocus);
  useEffect(() => {
    finalFocusRef.current = finalFocus;
  }, [finalFocus]);
  const restored = useRef(false);
  // Runs for Escape/Back (the route unmounts) and for history Back, which has no onClose call.
  // The explicit path also calls it, but the wrapper is still inert until the route commits, so
  // only a successful focus counts as restored; the unmount cleanup then gets the other turn.
  const restore = useCallback(() => {
    if (restored.current) return;
    const target = finalFocusRef.current();
    if (target === null) return;
    target.focus();
    if (document.activeElement === target) restored.current = true;
  }, []);
  useEffect(() => restore, [restore]);
  return (
    <BoardScreen
      onClose={() => {
        void navigate({ to: "/", search, replace: true });
        restore();
      }}
      onJump={(next) => {
        void navigate({ to: "/", search: next, replace: true });
        restore();
      }}
    />
  );
}
