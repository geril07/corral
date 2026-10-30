import { describeStatus } from "@corral/client/agent-status";
import type { AgentState, AgentStatus } from "@corral/protocol/rpc";

// Each state has its own shape, so the indicator does not rely on color.
const GLYPHS: Record<AgentState, string> = {
  blocked: "▲",
  error: "✕",
  working: "◐",
  done: "✓",
  idle: "○",
};

/** The agent's state as a glyph; the text alternative and the tooltip carry the words. */
export function StatusIndicator({ status }: { status: AgentStatus | undefined }) {
  if (!status) return <span className="status" aria-hidden />;
  const text = describeStatus(status);
  return (
    <span
      className="status"
      data-state={status.state}
      role="img"
      aria-label={text}
      title={status.message ? `${text}: ${status.message}` : text}
    >
      {GLYPHS[status.state]}
    </span>
  );
}
