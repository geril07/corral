import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { NativeCliFailure, runNativeCli } from "./native-cli.ts";

let root: string;
let bin: string;
let originalPath: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "corral-native-cli-"));
  bin = join(root, "bin");
  mkdirSync(bin);
  originalPath = process.env["PATH"];
  vi.stubEnv("PATH", `${bin}:${originalPath ?? ""}`);
});

afterEach(() => {
  vi.unstubAllEnvs();
  killLeftovers();
  rmSync(root, { recursive: true, force: true });
});

/** Pids the fake scripts left behind, so a hung grandchild does not outlive its test. */
function killLeftovers(): void {
  const log = join(root, "pids");
  if (!existsSync(log)) return;
  for (const line of readFileSync(log, "utf8").split("\n")) {
    const pid = Number(line.trim());
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** A fake `gh` that runs `script`, recording every pid it starts. */
function fakeCli(script: string): void {
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho $$ >> "${join(root, "pids")}"\n${script}\n`, {
    mode: 0o755,
  });
  chmodSync(join(bin, "gh"), 0o755);
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const base = {
  command: "gh",
  args: ["pr", "view"],
  cwd: tmpdir(),
  timeoutMs: 2000,
  provider: "github" as const,
  stripGitHubTokens: false,
  signal: undefined,
};

test("a CLI call is over when the CLI exits, even if a grandchild holds its pipes", async () => {
  // The grandchild inherits stdout and stderr; `close` would wait for it, `exit` does not.
  fakeCli("( sleep 30 & ) ; echo ok");
  const started = Date.now();
  const stdout = await runNativeCli({ ...base, timeoutMs: 20_000 });
  expect(stdout.trim()).toBe("ok");
  // Measured before the fix: the same call resolved at 30 s even with a 2 s deadline.
  expect(Date.now() - started).toBeLessThan(5000);
});

test("the deadline kills the CLI's whole process group", async () => {
  fakeCli("sleep 30");
  const started = Date.now();
  await expect(runNativeCli({ ...base, timeoutMs: 400 })).rejects.toMatchObject({
    kind: "timeout",
  });
  expect(Date.now() - started).toBeLessThan(5000);
  const pids = readFileSync(join(root, "pids"), "utf8")
    .split("\n")
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  expect(pids.length).toBeGreaterThan(0);
  // The shell the deadline killed is gone, and it took its `sleep` with it. A killed child stays
  // visible as a zombie until its parent reaps it, so this waits for the observable end.
  const deadline = Date.now() + 3000;
  while (isRunning(pids[0]!) && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- waiting for the process to be reaped is the point
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(isRunning(pids[0]!)).toBe(false);
});

test("a missing CLI is reported as missing, not as a timeout", async () => {
  await expect(runNativeCli({ ...base, command: "no-such-tool" })).rejects.toMatchObject({
    kind: "missing",
  });
  await expect(runNativeCli({ ...base, command: "no-such-tool" })).rejects.toBeInstanceOf(
    NativeCliFailure,
  );
});
