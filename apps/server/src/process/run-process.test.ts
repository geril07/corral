import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { ProcessFailure, runProcess } from "./run-process.ts";

let root: string;
let bin: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "corral-run-process-"));
  bin = join(root, "bin");
  mkdirSync(bin);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A fake `tool` on an absolute path that runs `script`. */
function fakeTool(script: string): string {
  const file = join(bin, "tool");
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  return file;
}

function run(command: string, options: { stdin?: string; timeoutMs?: number } = {}) {
  return runProcess({
    command,
    args: [],
    cwd: root,
    env: { ...process.env },
    timeoutMs: options.timeoutMs ?? 5000,
    maxBufferBytes: 1024 * 1024,
    signal: undefined,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
  });
}

test("no body means stdin is closed, so a reader sees EOF instead of waiting", async () => {
  // `cat` blocks until it reads EOF; the call only answers if the read end was closed for it.
  const tool = fakeTool("cat >/dev/null; echo done");
  await expect(run(tool)).resolves.toMatchObject({ stdout: "done\n", exitCode: 0 });
});

test("a body reaches the child, and a child that exits without reading it is not an error", async () => {
  const reader = fakeTool("cat");
  await expect(run(reader, { stdin: "the body\n" })).resolves.toMatchObject({
    stdout: "the body\n",
  });

  // Exits immediately, never touching stdin: the pipe's write end is closed by the parent, and that
  // EPIPE must not become the call's result (it used to surface as "Internal server error" in the
  // browser suite, where the server runs inside Vite's module runner).
  const deaf = fakeTool("echo ignored");
  await expect(run(deaf, { stdin: "the body\n" })).resolves.toMatchObject({
    stdout: "ignored\n",
    exitCode: 0,
  });
});

test("a missing executable is a typed failure, not a stream error", async () => {
  await expect(run(join(bin, "absent"))).rejects.toMatchObject({ kind: "missing" });
  await expect(run(join(bin, "absent"))).rejects.toBeInstanceOf(ProcessFailure);
});
