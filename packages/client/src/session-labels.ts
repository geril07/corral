import { normalizeLabel } from "@corral/protocol/label";
import type { Session } from "@corral/protocol/rpc";

/**
 * What the sidebar and the tab strip call each session of one task: the name the user gave it,
 * or its kind (`shell`, `claude`). Copies of one kind share that natural label; the strip's
 * numbered badge and their position tell them apart, so the label never carries an index.
 */
export function sessionLabels(sessions: readonly Session[]): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const session of sessions) {
    labels.set(session.id, normalizeLabel(session.label) ?? session.kind);
  }
  return labels;
}
