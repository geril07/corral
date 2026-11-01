/** The longest seed title, ellipsis included; short enough for a sidebar row (design.md, decision 16). */
export const SEED_TITLE_LENGTH = 60;

const ELLIPSIS = "…";

/**
 * The title a task created from a prompt shows at once: the prompt's first non-empty line with
 * its whitespace collapsed, cut at a word boundary to `SEED_TITLE_LENGTH` with an ellipsis. A
 * generated title replaces it later (decision 16); until then it is the task's name.
 */
export function seedTitle(prompt: string): string {
  const firstLine = prompt.split("\n").find((line) => line.trim() !== "") ?? "";
  const collapsed = firstLine.trim().replace(/\s+/g, " ");
  if (collapsed.length <= SEED_TITLE_LENGTH) return collapsed;
  // The ellipsis is part of the limit, so the kept text has one character less to use.
  const room = collapsed.slice(0, SEED_TITLE_LENGTH - ELLIPSIS.length);
  const boundary = room.lastIndexOf(" ");
  // A single word longer than the limit has no boundary to cut at; it is cut where it has to be.
  const kept = boundary > 0 ? room.slice(0, boundary) : room;
  return `${kept.trimEnd()}${ELLIPSIS}`;
}
