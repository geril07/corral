import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const FAKE_BIN = join(import.meta.dirname, "../../server/test/fake-agents/bin");
// Named by process, like the repositories (git-repos.ts): the config and the global setup load this module separately.
const root = join(tmpdir(), `corral-web-agents-${process.pid}`);
const logFile = join(root, "launches.jsonl");

/**
 * Puts the fake agents first on the server's `PATH` and gives Codex and Claude Code private config directories, so
 * that no test can start a real agent or touch `~/.codex` or `~/.claude`. The server runs in this process.
 */
export function useFakeAgents() {
  mkdirSync(join(root, "codex"), { recursive: true });
  mkdirSync(join(root, "claude"), { recursive: true });
  process.env["PATH"] = `${FAKE_BIN}${delimiter}${process.env["PATH"] ?? ""}`;
  process.env["CODEX_HOME"] = join(root, "codex");
  process.env["CLAUDE_CONFIG_DIR"] = join(root, "claude");
  process.env["FAKE_CLAUDE_TRANSCRIPT"] = "lazy";
  process.env["FAKE_AGENT_LOG"] = logFile;
  process.env["FAKE_CODEX_ROLLOUT"] = "eager";
  return () => rmSync(root, { recursive: true, force: true });
}

export function agentLaunches(): unknown[] {
  try {
    return readFileSync(logFile, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line): unknown => JSON.parse(line));
  } catch {
    return [];
  }
}

/** Sets (`null`: unsets) a variable of the server's environment; returns what it was before. */
export function serverEnv(_context: unknown, name: string, value: string | null): string | null {
  const before = process.env[name] ?? null;
  if (value === null) delete process.env[name];
  else process.env[name] = value;
  return before;
}
