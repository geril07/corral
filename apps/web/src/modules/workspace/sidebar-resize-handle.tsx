import type { PointerEvent as ReactPointerEvent } from "react";
import { clampSidebarWidth, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "./sidebar-pane.ts";

const KEY_STEP = 16;

/**
 * The sidebar's drag edge (`layout.md`, **Shell**): dragging resizes, a double click restores the
 * device default, and arrow keys do the same from the keyboard.
 */
export function SidebarResizeHandle({
  width,
  onResize,
  onReset,
}: {
  width: number;
  onResize: (width: number) => void;
  onReset: () => void;
}) {
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moved: PointerEvent) => onResize(startWidth + (moved.clientX - startX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      tabIndex={0}
      className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize hover:bg-border"
      onPointerDown={drag}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onResize(clampSidebarWidth(width - KEY_STEP));
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          onResize(clampSidebarWidth(width + KEY_STEP));
        }
      }}
    />
  );
}
