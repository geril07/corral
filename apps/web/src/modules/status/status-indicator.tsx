import { describeStatus } from "@corral/client/agent-status";
import type { AgentStatus } from "@corral/protocol/rpc";

/** The status and its reported reason for the stopped pane's alert. */
export function statusMessage(status: AgentStatus): string {
  const text = describeStatus(status);
  return status.message ? `${text}: ${status.message}` : text;
}
