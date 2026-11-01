import { describeStatus } from "@corral/client/agent-status";
import type { AgentStatus } from "@corral/protocol/rpc";
import { StatusGlyph, Hint } from "../../common/ui/index.ts";
import type { StatusGlyphSize } from "../../common/ui/status-glyph.tsx";

/**
 * The agent's state in a sidebar row: a fixed-size glyph, with the words as its text alternative
 * and tooltip. `muted` fades a `done` update the user has already seen.
 */
export function StatusIndicator({
  status,
  muted = false,
  size = "row",
}: {
  status: AgentStatus | undefined;
  muted?: boolean;
  /** `chrome` is the 14 px glyph of tabs and the task header (`layout.md`, **Status visuals**). */
  size?: StatusGlyphSize;
}) {
  if (!status) return <span className="w-5 shrink-0" aria-hidden />;
  const text = describeStatus(status);
  const message = status.message ? `${text}: ${status.message}` : text;
  return (
    <Hint content={message}>
      <span
        className="flex w-5 shrink-0 items-center justify-center"
        role="img"
        aria-label={text}
        title={message}
      >
        <StatusGlyph state={status.state} muted={muted} size={size} />
      </span>
    </Hint>
  );
}
