import { describeStatus } from "@corral/client/agent-status";
import type { AgentStatus } from "@corral/protocol/rpc";
import { StatusGlyph, Hint } from "../../common/ui/index.ts";

/** The agent's state: a fixed-size glyph, with the words as its text alternative and tooltip. */
export function StatusIndicator({ status }: { status: AgentStatus | undefined }) {
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
        <StatusGlyph state={status.state} />
      </span>
    </Hint>
  );
}
