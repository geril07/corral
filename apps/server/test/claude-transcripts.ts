import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Where Claude Code keeps a conversation: `<config dir>/projects/<cwd with non-alphanumerics as "-">/<id>.jsonl`. */
export function writeClaudeTranscript(configDir: string, cwd: string, id: string): string {
  const directory = join(configDir, "projects", cwd.replaceAll(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({ type: "user", sessionId: id, cwd })}\n`);
  return path;
}

export function claudeTranscriptExists(configDir: string, id: string): boolean {
  const projects = join(configDir, "projects");
  return (
    existsSync(projects) &&
    readdirSync(projects).some((directory) => existsSync(join(projects, directory, `${id}.jsonl`)))
  );
}
