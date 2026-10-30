import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, vi } from "vite-plus/test";

export const FAKE_BIN = join(import.meta.dirname, "fake-agents", "bin");

export interface Launch {
  agent: "claude" | "codex" | "pi" | "opencode";
  argv: string[];
  cwd: string;
  pid: number;
  /** The conversation id the fake codex writes its rollout under, when it started a conversation. */
  rolloutId?: string;
  env: { CORRAL_SESSION_ID?: string; CORRAL_TASK_ID?: string };
}

/**
 * Puts the fake agents (`fake-agents/`) first on `PATH` for the test and points `CODEX_HOME` at
 * a temporary directory, so nothing reaches the real CLIs or the real `~/.codex`. The server
 * reads the environment when it launches a session, so this works with `useServer()` in any order.
 */
export function useFakeAgents() {
  let root: string;
  let logFile: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "corral-agents-"));
    logFile = join(root, "launches.jsonl");
    vi.stubEnv("PATH", `${FAKE_BIN}${delimiter}${process.env["PATH"] ?? ""}`);
    vi.stubEnv("CODEX_HOME", join(root, "codex"));
    vi.stubEnv("FAKE_AGENT_LOG", logFile);
    vi.stubEnv("FAKE_CODEX_ROLLOUT", "eager");
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  return {
    /** What `CODEX_HOME` is for the server under test. */
    get codexHome() {
      return join(root, "codex");
    },
    /** Every launch so far, oldest first. */
    async launches(): Promise<Launch[]> {
      const text = await readFile(logFile, "utf8").catch(() => "");
      return text
        .split("\n")
        .filter((line) => line !== "")
        .map((line): Launch => JSON.parse(line));
    },
  };
}
