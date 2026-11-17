import type { ChatContextUsage } from "@corral/protocol/chat";

/** Above this share the ring switches to the warning tone, as T3's meter does at 90%. */
export const DANGER_PERCENTAGE = 90;

/**
 * The share of the window in use, rounded to a whole percent. Clamped at 100: an agent may report
 * more tokens than the window it named (past the limit), and a ring has no way to show that.
 */
export function contextPercentage(usage: ChatContextUsage): number | null {
  if (usage.maxTokens === null) return null;
  return Math.min(100, Math.round((usage.usedTokens / usage.maxTokens) * 100));
}

/** The percentage as the reader sees it; under ten a tenth matters, above it a whole is noise-free. */
export function contextPercentageText(usage: ChatContextUsage): string | null {
  if (usage.maxTokens === null) return null;
  const exact = (usage.usedTokens / usage.maxTokens) * 100;
  return exact < 10 ? `${exact.toFixed(1).replace(/\.0$/, "")}%` : `${Math.round(exact)}%`;
}

/** Token counts as the composer shows them: `950`, `3.2k`, `45k`, `1.2m`. */
export function formatTokens(value: number): string {
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 999_500) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

/** The meter's accessible name: the same reading its tooltip carries. */
export function contextLabel(usage: ChatContextUsage): string {
  const percentage = contextPercentageText(usage);
  return percentage === null
    ? `Context window ${formatTokens(usage.usedTokens)} tokens used`
    : `Context window ${percentage} used`;
}

/** The tooltip's line: the share and the counts, or just the count when the agent named no window. */
export function contextDetail(usage: ChatContextUsage): string {
  const percentage = contextPercentageText(usage);
  if (percentage === null || usage.maxTokens === null) {
    return `Context window · ${formatTokens(usage.usedTokens)} tokens`;
  }
  return `Context window · ${percentage} · ${formatTokens(usage.usedTokens)}/${formatTokens(usage.maxTokens)} tokens`;
}
