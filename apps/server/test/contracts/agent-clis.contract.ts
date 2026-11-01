// Keeps the fake agents and the adapters (`src/agents/`) honest against the real CLIs installed
// on this machine. Cheap and offline: `--help` output and a read of an existing Codex rollout;
// this file starts no agent conversation. The one contract suite that does is `pi-rpc.contract.ts`:
// the real pi binary in RPC mode against a local OpenAI-compatible stub on port 0, no paid calls
// and no writes to the user's pi directory. An agent that is not installed is skipped.
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

test.skipIf(!installed("claude"))("claude takes --model and has no provider flag", async () => {
  const text = await help("claude");
  expect(text).toMatch(/--model <model>/);
  expect(text).not.toMatch(/--provider\b/);
});

test.skipIf(!installed("claude"))(
  "claude --resume of an id with no conversation exits 1 with 'No conversation found', without a network call",
  async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const result = await run("claude", ["-p", "--resume", id, "hi"], {
      timeout: 30_000,
      cwd: sandbox,
      env: { PATH: process.env["PATH"], HOME: sandbox, CLAUDE_CONFIG_DIR: join(sandbox, "claude") },
    }).then(
      ({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
      (error: { code: number; stdout: string; stderr: string }) => ({
        code: error.code,
        output: error.stdout + error.stderr,
      }),
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain(`No conversation found with session ID: ${id}`);
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

test.skipIf(!installed("codex"))(
  "codex takes -m and -c model_provider=… both at start and on resume",
  async () => {
    for (const text of [await help("codex"), await help("codex", "resume")]) {
      expect(text).toMatch(/-m, --model <MODEL>/);
      expect(text).toMatch(/-c, --config <key=value>/);
    }
  },
);

test.skipIf(!installed("pi"))(
  "pi takes --provider with --model, and provider needs a model",
  async () => {
    const text = await help("pi");
    expect(text).toMatch(/--provider <name>\s+Provider to search for --model \(requires --model\)/);
    expect(text).toMatch(/--model <pattern>/);
  },
);

test.skipIf(!installed("opencode"))(
  "opencode 2.1.4 has --session but no root model or provider flag",
  async () => {
    const text = await help("opencode");
    expect(text).toMatch(/--session, -s string/);
    expect(text).not.toMatch(/--model\b/);
    expect(text).not.toMatch(/--provider\b/);
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
