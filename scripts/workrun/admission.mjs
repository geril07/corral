import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { BUSY, identifier } from "./model.mjs";

export async function lockPath(group) {
  identifier(group, "group");
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (!runtime || !isAbsolute(runtime))
    throw new Error("XDG_RUNTIME_DIR must name the user's runtime directory");
  const info = await stat(runtime);
  if (info.uid !== process.getuid() || info.mode & 0o077) {
    throw new Error("XDG_RUNTIME_DIR must be private and owned by the current user");
  }
  // Stable inodes across checkouts; never unlink a lock that another launcher may still hold.
  return join(runtime, `workrun-${group}.lock`);
}

export function busy(group) {
  return Object.assign(new Error(`heavy slots busy in ${group}`), { exitCode: BUSY });
}

export async function withGroupLock(group, action, { signal } = {}) {
  signal?.throwIfAborted();
  const path = await lockPath(group);
  signal?.throwIfAborted();
  // flock owns exclusion. The pipe owns its lifetime: even a killed CLI closes stdin, so this
  // short-lived guard exits without a persistent lock owner, daemon or PID registry.
  const child = spawn(
    "flock",
    [
      "--no-fork",
      path,
      process.execPath,
      "-e",
      'process.stdout.write("locked\\n"); process.stdin.resume();',
    ],
    { stdio: ["pipe", "pipe", "pipe"], detached: true },
  );
  child.stdin.on("error", () => {});
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  const done = new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code));
  });
  const acquired = new Promise((resolveLock) => {
    child.stdout.once("data", () => resolveLock());
  });
  const cancel = () => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
    } catch {
      /* The guard already exited. */
    }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    await Promise.race([
      acquired,
      done.then((code) => {
        signal?.throwIfAborted();
        throw new Error(stderr.trim() || `flock exited ${code} before acquiring the group lock`);
      }),
    ]);
    signal?.throwIfAborted();
    return await action();
  } finally {
    child.stdin.end();
    await done;
    signal?.removeEventListener("abort", cancel);
  }
}
