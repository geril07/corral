import type { Session } from "@corral/protocol/rpc";

/**
 * What the sidebar calls each session of one task. A kind that appears more than once gets a
 * number on every copy after the first (`shell`, `shell 2`), so two shells can be told apart.
 */
export function sessionLabels(sessions: readonly Session[]): ReadonlyMap<string, string> {
  const totals = new Map<string, number>();
  for (const session of sessions) totals.set(session.kind, (totals.get(session.kind) ?? 0) + 1);

  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const session of sessions) {
    const index = (seen.get(session.kind) ?? 0) + 1;
    seen.set(session.kind, index);
    const numbered = (totals.get(session.kind) ?? 0) > 1;
    labels.set(session.id, numbered && index > 1 ? `${session.kind} ${index}` : session.kind);
  }
  return labels;
}
