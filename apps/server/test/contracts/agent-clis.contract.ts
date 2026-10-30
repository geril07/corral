// Keeps the fake agents and the adapters (`src/agents/`) honest against the real CLIs installed
// on this machine. Cheap and offline: `--help` output and a read of an existing Codex rollout;
// no agent conversation is ever started. An agent that is not installed is skipped.
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import { isExecutable } from "../../src/agents/executable-lookup.ts";
import { codexHome, parseRolloutHead } from "../../src/agents/codex-sessions.ts";

const run = promisify(execFile);
let sandbox: string;

beforeAll(async () => {
  sandbox = await mkdtemp(join(tmpdir(), "corral-contract-"));
});
afterAll(() => rm(sandbox, { recursive: true, force: true }));

/** `--help` of the real CLI, run with an empty home so it cannot touch the user's agent state. */
async function help(command: string, ...args: string[]): Promise<string> {
  const { stdout, stderr } = await run(command, [...args, "--help"], {
    timeout: 30_000,
    env: {
      PATH: process.env["PATH"],
      HOME: sandbox,
      XDG_CONFIG_HOME: join(sandbox, "config"),
      XDG_DATA_HOME: join(sandbox, "data"),
      XDG_STATE_HOME: join(sandbox, "state"),
      XDG_CACHE_HOME: join(sandbox, "cache"),
      CODEX_HOME: join(sandbox, "codex"),
      CLAUDE_CONFIG_DIR: join(sandbox, "claude"),
      PI_CODING_AGENT_DIR: join(sandbox, "pi"),
    },
  });
  return stdout + stderr;
}

const installed = (command: string) => isExecutable(command, process.env["PATH"]);

test.skipIf(!installed("claude"))(
  "claude takes --session-id <uuid> and --resume <id>",
  async () => {
    const text = await help("claude");
    expect(text).toMatch(/--session-id <uuid>/);
    expect(text).toMatch(/--resume \[value\]|--resume <session-id>/);
  },
);

test.skipIf(!installed("pi"))(
  "pi takes --session-id <id> that creates the session when missing",
  async () => {
    expect(await help("pi")).toMatch(
      /--session-id <id>\s+Use exact project session ID, creating it if missing/,
    );
  },
);

test.skipIf(!installed("opencode"))(
  "opencode takes --session <id> that creates the session when missing",
  async () => {
    expect(await help("opencode")).toMatch(
      /--session, -s string\s+Session ID to continue, or to create if it does not exist/,
    );
  },
);

test.skipIf(!installed("codex"))(
  "codex has no flag for choosing an id, and resumes with `codex resume <id>`",
  async () => {
    expect(await help("codex")).not.toMatch(/--session-id/);
    expect(await help("codex", "resume")).toMatch(/Usage: codex resume \[OPTIONS\] \[SESSION_ID\]/);
  },
);

// Reads, never writes, the user's real Codex home: the format our discovery depends on.
test("the first line of a real Codex rollout is a session_meta record our parser understands", async (context) => {
  const sessions = join(codexHome(process.env), "sessions");
  const rollout = await newestRollout(sessions);
  if (!rollout) context.skip();
  const firstLine = (await readFile(rollout!, "utf8")).split("\n")[0]!;
  expect(parseRolloutHead(firstLine)).toMatchObject({
    id: expect.any(String),
    cwd: expect.any(String),
    startedAt: expect.any(Number),
  });
});

async function newestRollout(directory: string): Promise<string | undefined> {
  let newest: string | undefined;
  const entries = await readdir(directory, { withFileTypes: true, recursive: true }).catch(
    () => [],
  );
  for (const entry of entries)
    if (entry.isFile() && /^rollout-.*\.jsonl$/.test(entry.name)) {
      const path = join(entry.parentPath, entry.name);
      if (!newest || entry.name > newest.split("/").pop()!) newest = path;
    }
  return newest;
}
