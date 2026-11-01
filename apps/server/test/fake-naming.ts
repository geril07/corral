import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, vi } from "vite-plus/test";

export const FAKE_NAMING_BIN = join(import.meta.dirname, "fake-naming", "bin");

export interface NamingRunLog {
  agent: string;
  argv: string[];
  cwd: string;
  env: { ANTHROPIC_AUTH_TOKEN?: string };
}

/**
 * Puts the fake naming CLIs on `PATH` and narrows `PATH` to what a naming test needs: the fakes,
 * the running Node, and a directory holding only `git`. The machine's real `claude`, `pi`, `codex`
 * and `opencode` are reachable from the normal `PATH`; a naming test must never start one (it
 * would be a paid call against the user's own account). The naming code reads `process.env` when
 * it runs, so this works with `useServer()` in any order.
 */
export function useFakeNaming() {
  let root: string;
  let logFile: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "corral-naming-"));
    logFile = join(root, "runs.jsonl");
    const tools = join(root, "tools");
    await mkdir(tools);
    const git = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    await symlink(git, join(tools, "git"));
    vi.stubEnv("PATH", [FAKE_NAMING_BIN, dirname(process.execPath), tools].join(delimiter));
    vi.stubEnv("FAKE_NAMING_LOG", logFile);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  return {
    /** Every naming run so far, oldest first. */
    async runs(): Promise<NamingRunLog[]> {
      const text = await readFile(logFile, "utf8").catch(() => "");
      return text
        .split("\n")
        .filter((line) => line !== "")
        .map((line): NamingRunLog => JSON.parse(line));
    },
  };
}
