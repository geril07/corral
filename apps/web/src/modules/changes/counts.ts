import type { TaskChanges } from "@corral/protocol/rpc";

/**
 * The compact `+N −M` a task header and a sidebar row show (`layout.md`, **Task header**, **Sidebar**),
 * or `undefined` when the task changed nothing countable. A total that is a lower bound — the file
 * list was capped, or a file was counted from a prefix — says so instead of presenting the number
 * as final. No counts at all means no text: `layout.md` shows them only when non-zero.
 */
export function changeCounts(changes: TaskChanges | undefined): string | undefined {
  if (changes === undefined) return undefined;
  if (changes.additions === 0 && changes.deletions === 0) return undefined;
  const partial = changes.truncated || changes.files.some((file) => file.partial);
  return `+${changes.additions} −${changes.deletions}${partial ? " (partial)" : ""}`;
}

/** Whether a task's totals are a lower bound; the tab's summary row says why. */
export function totalsArePartial(changes: TaskChanges): boolean {
  return changes.truncated || changes.files.some((file) => file.partial);
}
