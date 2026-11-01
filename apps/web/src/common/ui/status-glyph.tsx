import type { AgentState } from "@corral/protocol/rpc";
import { Icon } from "./icon.tsx";

/** `row` is the 12 px glyph of sidebar rows, `chrome` the 14 px one of tabs and the task header. */
export type StatusGlyphSize = "row" | "chrome";

const COLORS: Readonly<Record<AgentState, string>> = {
  working: "text-status-working",
  blocked: "text-status-attention",
  error: "text-destructive",
  done: "text-status-done",
  idle: "text-muted-foreground",
};

/**
 * Shape, the caller's accessible name and the status color distinguish states (`layout.md`,
 * **Status visuals**). `muted` fades a finished update the user has already seen.
 */
export function StatusGlyph({
  state = "idle",
  size = "row",
  muted = false,
}: {
  state?: AgentState | undefined;
  size?: StatusGlyphSize;
  muted?: boolean;
}) {
  return (
    <span
      className={muted ? "text-muted-foreground" : COLORS[state]}
      aria-hidden
      data-status={state}
    >
      <Icon name={`status-${state}`} className={size === "row" ? "size-3" : "size-3.5"} />
    </span>
  );
}
