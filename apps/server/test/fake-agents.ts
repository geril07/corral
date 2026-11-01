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
  env: {
    CORRAL_SESSION_ID?: string;
    CORRAL_TASK_ID?: string;
    CORRAL_STATUS_URL?: string;
    CORRAL_STATUS_TOKEN?: string;
  };
  /** The variables named by $FAKE_AGENT_LOG_ENV, so a test can see an explicit profile value. */
  envSentinels: Record<string, string | undefined>;
  /** The fake opencode only: what the server's inline config would load into the real one. */
  opencode?: { configContent: string; pluginDir?: string; pluginPresent: boolean };
}

/**
 * Puts the fake agents (`fake-agents/`) first on `PATH` for the test and points `CODEX_HOME`,
 * `CLAUDE_CONFIG_DIR` and `OPENCODE_CONFIG_DIR` at temporary directories, so nothing reaches the
 * real CLIs, `~/.codex`, `~/.claude` or `~/.config/opencode`. A developer's own inline OpenCode
 * config is blanked, or the server would (rightly) not inject the status plugin. The server
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
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "claude"));
    vi.stubEnv("OPENCODE_CONFIG_DIR", join(root, "opencode"));
    vi.stubEnv("OPENCODE_CONFIG_CONTENT", "");
    vi.stubEnv("FAKE_AGENT_LOG", logFile);
    // The fake `opencode serve`: its own journal and the directory that makes sessions survive a
    // restart of the process, as OpenCode's data directory does.
    vi.stubEnv("FAKE_OPENCODE_LOG", join(root, "opencode-server.jsonl"));
    vi.stubEnv("FAKE_OPENCODE_STATE", join(root, "opencode-state"));
    // The fake pi's RPC journal: a resumed process rebuilds its history from here.
    vi.stubEnv("FAKE_PI_RPC_HOME", join(root, "pi-rpc"));
    vi.stubEnv("FAKE_CODEX_ROLLOUT", "eager");
    vi.stubEnv("FAKE_CLAUDE_TRANSCRIPT", "lazy");
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
    /** What `CLAUDE_CONFIG_DIR` is for the server under test. */
    get claudeConfigDir() {
      return join(root, "claude");
    },
    /** Where the fake pi's RPC journals live, one per session id. */
    get piRpcHome() {
      return join(root, "pi-rpc");
    },
    /** What the fake `opencode serve` journaled (sessions, prompts, permissions, clients). */
    get openCodeLog() {
      return join(root, "opencode-server.jsonl");
    },
    /** The fake OpenCode data directory: a restarted server reads the sessions it wrote. */
    get openCodeState() {
      return join(root, "opencode-state");
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
