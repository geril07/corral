/** Active terminal rules over the ordered list of terminal ids. */

/** The terminal to show: the chosen one if it still exists, else the first. */
export function effectiveActive(
  ids: readonly string[],
  chosen: string | undefined,
): string | undefined {
  return chosen !== undefined && ids.includes(chosen) ? chosen : ids[0];
}

/** The next (+1) or previous (-1) terminal, wrapping around. */
export function stepActive(
  ids: readonly string[],
  active: string | undefined,
  step: 1 | -1,
): string | undefined {
  if (ids.length === 0) return undefined;
  const index = active === undefined ? -1 : ids.indexOf(active);
  if (index === -1) return ids[0];
  return ids[(index + step + ids.length) % ids.length];
}

/** What to show once `closing` is gone: the one after it, else the one before. */
export function activeAfterClose(ids: readonly string[], closing: string): string | undefined {
  const index = ids.indexOf(closing);
  if (index === -1) return undefined;
  return ids[index + 1] ?? ids[index - 1];
}
