import { describeStatus } from "@corral/client/agent-status";
import type { AgentStatus } from "@corral/protocol/rpc";

/** The status's words with its reason when one was reported; the glyph and row tooltip share them. */
export function statusMessage(status: AgentStatus): string {
  const text = describeStatus(status);
  return status.message ? `${text}: ${status.message}` : text;
}
