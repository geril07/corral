import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Writes a file into a repository a browser test created (`createGitRepo`), so a chat message can
 * name a real path, image or video. Browser tests cannot touch the filesystem themselves; this runs
 * in the test server's process as a custom command.
 */
export function writeRepoFile(
  _context: unknown,
  root: string,
  name: string,
  content: { text: string } | { base64: string },
): void {
  const path = join(root, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "text" in content ? content.text : Buffer.from(content.base64, "base64"));
}
