import { z } from "zod";
import { AgentState, AgentStatus } from "./rpc.ts";

/**
 * Status channel for agents that cannot report through OSC 7501 (OpenCode, via its plugin).
 * Every agent process gets `CORRAL_STATUS_URL` and `CORRAL_STATUS_TOKEN` in its environment;
 * it POSTs a `StatusReport` as JSON to that URL with `Authorization: Bearer <token>`. The URL
 * and token belong to one launch of one session; a stale or foreign token gets 403.
 */
export function statusReportPath(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}/status`;
}

export const StatusReport = z.object({
  state: AgentState,
  kind: AgentStatus.shape.kind,
  message: z.string().max(2048).optional(),
});
export type StatusReport = z.infer<typeof StatusReport>;
