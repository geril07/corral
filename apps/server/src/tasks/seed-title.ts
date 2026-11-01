/** The longest seed title, ellipsis included; short enough for a sidebar row (design.md, decision 16). */
export const SEED_TITLE_LENGTH = 60;

const ELLIPSIS = "…";

/** One visible character per grapheme, so a cut never lands inside an emoji or a joined sequence. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The title a task created from a prompt shows at once: the prompt's first non-empty line with
 * its whitespace collapsed, cut at a word boundary to `SEED_TITLE_LENGTH` with an ellipsis. A
 * generated title replaces it later (decision 16); until then it is the task's name.
 */
export function seedTitle(prompt: string): string {
  const firstLine = prompt.split("\n").find((line) => line.trim() !== "") ?? "";
  const collapsed = firstLine.trim().replace(/\s+/g, " ");
  // Counted and cut per grapheme, not per UTF-16 unit: a cut inside a surrogate pair or a joined
  // emoji leaves half a character, which SQLite keeps as replacement glyphs.
  const characters = Array.from(GRAPHEMES.segment(collapsed), (each) => each.segment);
  if (characters.length <= SEED_TITLE_LENGTH) return collapsed;
  // The ellipsis is part of the limit, so the kept text has one character less to use.
  const room = characters.slice(0, SEED_TITLE_LENGTH - 1);
  const boundary = room.lastIndexOf(" ");
  // A single word longer than the limit has no boundary to cut at; it is cut where it has to be.
  const kept = boundary > 0 ? room.slice(0, boundary) : room;
  return `${kept.join("").trimEnd()}${ELLIPSIS}`;
}
