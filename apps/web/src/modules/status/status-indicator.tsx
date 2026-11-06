import { describeStatus } from "@corral/client/agent-status";
import type { AgentStatus } from "@corral/protocol/rpc";
import { StatusGlyph, Hint, type StatusGlyphSize } from "../../common/ui/index.ts";

/** The status's words with its reason when one was reported; the glyph and row tooltip share them. */
export function statusMessage(status: AgentStatus): string {
  const text = describeStatus(status);
  return status.message ? `${text}: ${status.message}` : text;
}

/**
 * The agent's state in a sidebar row: a fixed-size glyph, with the words as its text alternative
 * and tooltip. `muted` fades a `done` update the user has already seen.
 */
export function StatusIndicator({
  status,
  muted = false,
  size = "row",
  tooltip = true,
}: {
  status: AgentStatus | undefined;
  muted?: boolean;
  /** `chrome` is the 14 px glyph of tabs and the task header (`layout.md`, **Task header**, **Session tabs**). */
  size?: StatusGlyphSize;
  /** A sidebar row owns one tooltip for all its facts; the glyph then carries only its text alternative. */
  tooltip?: boolean;
}) {
  if (!status) return <span className="w-5 shrink-0" aria-hidden />;
  const text = describeStatus(status);
  const message = statusMessage(status);
  const glyph = (
    <span
      className="flex w-5 shrink-0 items-center justify-center"
      role="img"
      aria-label={text}
      title={tooltip ? message : undefined}
    >
      <StatusGlyph state={status.state} muted={muted} size={size} />
    </span>
  );
  return tooltip ? <Hint content={message}>{glyph}</Hint> : glyph;
}
