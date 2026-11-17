import type { VisualTaskRow } from "../../common/ui/index.ts";

/**
 * The finder's rows in the sidebar's own order when the query is empty, and the best match first
 * when it is not. A query is a plain AND of whitespace-separated words; every word must appear in
 * the title, the branch, the project name or the word `settled`. Ranking follows the best field
 * each word hit — title before branch before project — and equal scores keep the caller's order,
 * so active rows stay ahead of settled ones.
 */
export function searchTasks(query: string, rows: readonly VisualTaskRow[]): VisualTaskRow[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) return [...rows];

  const scored: { row: VisualTaskRow; score: number }[] = [];
  for (const row of rows) {
    let score = 0;
    for (const word of words) {
      const matched = matchScore(word, row);
      if (matched === 0) {
        score = 0;
        break;
      }
      score += matched;
    }
    if (score > 0) scored.push({ row, score });
  }
  return scored.toSorted((a, b) => b.score - a.score).map(({ row }) => row);
}

/** Title starts, then a word in it, then any title text, then branch, project, state. */
function matchScore(word: string, row: VisualTaskRow): number {
  const title = row.title.toLowerCase();
  if (title.startsWith(word)) return 100;
  if (title.split(/\s+/).some((part) => part.startsWith(word))) return 80;
  if (title.includes(word)) return 60;
  if (row.copyBranch?.toLowerCase().includes(word)) return 40;
  if (row.project.toLowerCase().includes(word)) return 20;
  if (row.settled === true && word === "settled") return 10;
  return 0;
}
