import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The server-side half of the browser command: a browser test cannot write the files a task's
 * workspace should show, so it asks the test run's Node process to write them into the worktree
 * the real server gave it.
 */
export function writeFilesIn(
  _context: unknown,
  directory: string,
  files: Record<string, string>,
): void {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, name)), { recursive: true });
    writeFileSync(join(directory, name), content);
  }
}
