import type { PointerEvent as ReactPointerEvent } from "react";
import { SIDEBAR_MIN_WIDTH } from "./sidebar-pane.ts";

const KEY_STEP = 16;

/**
 * The sidebar's drag edge (`layout.md`, **Shell**): dragging resizes, a double click restores the
 * device default, and arrow keys do the same from the keyboard. The strip sits just outside the
 * aside, over the main area's 8 px padding, so it never covers the sidebar list's scrollbar.
 */
export function SidebarResizeHandle({
  width,
  maxWidth,
  onResize,
  onReset,
}: {
  width: number;
  /** The window's own maximum (`min(420, innerWidth − 640)`), re-read when the window resizes. */
  maxWidth: number;
  onResize: (width: number) => void;
  onReset: () => void;
}) {
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    const move = (moved: PointerEvent) => onResize(startWidth + (moved.clientX - startX));
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      handle.removeEventListener("lostpointercapture", stop);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    };
    // Capture routes the move and end events here; every way a drag can end removes them again.
    handle.setPointerCapture(event.pointerId);
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
    handle.addEventListener("lostpointercapture", stop);
  };

  // `z-10` keeps the 6 px strip above the later <main> sibling, which paints and hit-tests
  // above the aside at z-index auto; without it the edge would be the 1 px border at most.
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={maxWidth}
      tabIndex={0}
      className="absolute inset-y-0 -right-1.5 z-10 w-1.5 cursor-col-resize hover:bg-border"
      onPointerDown={drag}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onResize(width - KEY_STEP);
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          onResize(width + KEY_STEP);
        }
      }}
    />
  );
}
