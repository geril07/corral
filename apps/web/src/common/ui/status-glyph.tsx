import type { AgentState } from "@corral/protocol/rpc";
import { Icon, type IconSize } from "./icon.tsx";

/** `row` is 12 px, `chrome` 14 px, `default` the 16 px glyph of a working-area tab. */
export type StatusGlyphSize = IconSize;

const COLORS: Readonly<Record<AgentState, string>> = {
  working: "text-status-working",
  blocked: "text-status-attention",
  error: "text-destructive",
  done: "text-status-done",
  idle: "text-muted-foreground",
};

/**
 * Shape, the caller's accessible name and the status color distinguish states (`layout.md`,
 * **Task header**, **Working area**). `muted` fades a finished update the user has already seen.
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
      <Icon name={`status-${state}`} size={size} />
    </span>
  );
}
