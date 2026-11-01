import type { ChatItem, ChatToolCall } from "@corral/protocol/chat";

/**
 * One timeline row: an item, or a run of finished tool calls folded into one line
 * (`layout.md`, **Chat**: "Consecutive finished tool calls fold into '6 tool calls' until
 * expanded"). A running call stays its own row, because its output is still arriving.
 */
export type ChatRow =
  | { kind: "item"; key: string; item: ChatItem }
  | { kind: "tools"; key: string; items: readonly ChatToolCall[] };

/** Folds runs of two or more finished tool calls; a single finished call keeps its own line. */
export function chatRows(items: readonly ChatItem[]): ChatRow[] {
  const rows: ChatRow[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) continue;
    if (item.kind === "tool-call" && item.status !== "running") {
      const run: ChatToolCall[] = [item];
      while (index + run.length < items.length) {
        const next = items[index + run.length];
        if (next?.kind !== "tool-call" || next.status === "running") break;
        run.push(next);
      }
      if (run.length > 1) {
        rows.push({ kind: "tools", key: `tools:${item.id}`, items: run });
        index += run.length - 1;
        continue;
      }
    }
    rows.push({ kind: "item", key: item.id, item });
  }
  return rows;
}

/** The pending request the agent waits on, if any; the last one wins if a driver appends two. */
export function pendingRequest(items: readonly ChatItem[]) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "user-request" && item.status === "pending") return item;
  }
  return undefined;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The one-line argument hint of a tool row. It reads the call's shape, not the driver's tool name:
 * the first string a JSON object carries (a command, a path) or the raw text when it is not JSON.
 */
export function toolSummary(argumentsText: string): string {
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (parsed !== null && typeof parsed === "object") {
      const first = Object.values(parsed).find(
        (value): value is string => typeof value === "string" && value.trim() !== "",
      );
      if (first !== undefined) return oneLine(first);
    }
  } catch {
    // Not JSON: the arguments are already text the agent wrote, so show them as they are.
  }
  return oneLine(argumentsText);
}
