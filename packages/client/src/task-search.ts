import type { Project, Task } from "@corral/protocol/rpc";

/** A task and the project it belongs to, as the task search shows and opens it. */
export interface TaskSearchResult {
  task: Task;
  project: Project;
}

/**
 * Tasks whose parent project is missing from the list yet are left out, as in the sidebar.
 *
 * An empty query browses: active tasks before settled ones, each newest first, ties by title
 * and then id so the order never depends on the server's list order. A non-empty query is a
 * plain AND of whitespace-separated words; every word must appear in the title, branch, project
 * name or task state, case-insensitively. Results are ranked by the best field each word hit
 * (title before branch before project), then newest first, with the same title/id tie-break.
 */
export function searchTasks(
  query: string,
  projects: readonly Project[],
  tasks: readonly Task[],
): TaskSearchResult[] {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const rows: TaskSearchResult[] = [];
  for (const task of tasks) {
    const project = task.projectId === null ? undefined : projectById.get(task.projectId);
    if (project) rows.push({ task, project });
  }

  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) return rows.toSorted(byBrowseOrder);

  const scored: { row: TaskSearchResult; score: number }[] = [];
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
  return scored
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        b.row.task.createdAt - a.row.task.createdAt ||
        compareText(a.row.task.title, b.row.task.title) ||
        compareText(a.row.task.id, b.row.task.id),
    )
    .map(({ row }) => row);
}

/** Title starts, then a word in it, then any title text, then branch, project, state. */
function matchScore(word: string, { task, project }: TaskSearchResult): number {
  const title = task.title.toLowerCase();
  if (title.startsWith(word)) return 100;
  if (title.split(/\s+/).some((part) => part.startsWith(word))) return 80;
  if (title.includes(word)) return 60;
  if (task.branch?.toLowerCase().includes(word)) return 40;
  if (project.name.toLowerCase().includes(word)) return 20;
  if (task.state === word) return 10;
  return 0;
}

function byBrowseOrder(a: TaskSearchResult, b: TaskSearchResult): number {
  if (a.task.state !== b.task.state) return a.task.state === "active" ? -1 : 1;
  return (
    b.task.createdAt - a.task.createdAt ||
    compareText(a.task.title, b.task.title) ||
    compareText(a.task.id, b.task.id)
  );
}

/** Locale-independent, unlike `localeCompare`, so the order is the same everywhere. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
