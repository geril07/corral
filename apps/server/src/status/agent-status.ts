import type { AgentStatus } from "@corral/protocol/rpc";
import type { StatusReport } from "@corral/protocol/status-report";
import { outlivesProgram } from "./osc7501-protocol.ts";

export function statusFromReport(report: StatusReport, now: number): AgentStatus {
  return {
    state: report.state,
    ...(report.kind !== undefined ? { kind: report.kind } : {}),
    ...(report.message !== undefined ? { message: report.message } : {}),
    updatedAt: now,
  };
}

/** Whether a user would see a difference; `updatedAt` is when the status last changed, so a repeat does not move it. */
export function sameStatus(a: AgentStatus | null, b: AgentStatus | null): boolean {
  if (a === null || b === null) return a === b;
  return a.state === b.state && a.kind === b.kind && a.message === b.message;
}

/** The program ended: what it was doing is over, but its verdict stays. */
export function statusAfterExit(status: AgentStatus | null): AgentStatus | null {
  return status !== null && outlivesProgram(status.state) ? status : null;
}
