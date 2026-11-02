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
import { initRepo, runGit } from "../../test/git-repo.ts";
import { GitError, git, gitRead } from "./git.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "corral-git-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

/** A fake `git` first on PATH that runs `script`, so a hang or an overflow is a controlled case. */
function fakeGit(script: string): void {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const file = join(bin, "git");
  writeFileSync(file, `#!/bin/sh\n${script}\n`);
  chmodSync(file, 0o755);
  vi.stubEnv("PATH", `${bin}:${process.env["PATH"] ?? ""}`);
}

test("a git call that never finishes becomes a GitError instead of holding the caller", async () => {
  fakeGit("sleep 5");
  await expect(git(root, ["status"], { timeoutMs: 100 })).rejects.toThrow(GitError);
  await expect(git(root, ["status"], { timeoutMs: 100 })).rejects.toThrow(
    "git status did not finish within 100 ms",
  );
});

test("git output over the buffer becomes a GitError", async () => {
  fakeGit("head -c 4096 /dev/zero");
  await expect(git(root, ["status"], { maxOutputBytes: 1024 })).rejects.toThrow(
    /wrote more than 1 KiB/,
  );
});

test("stdin is closed, so a command that reads it sees EOF instead of waiting", async () => {
  fakeGit("cat >/dev/null; echo done");
  await expect(git(root, ["status"], { timeoutMs: 2000 })).resolves.toBe("done\n");
});

test("a read-only git call tells git not to lock, not to glob and not to refresh the index", async () => {
  fakeGit(
    'printf "%s|%s|%s|%s" "$GIT_OPTIONAL_LOCKS" "$GIT_LITERAL_PATHSPECS" "$GIT_CONFIG_KEY_0" "$GIT_CONFIG_VALUE_0"',
  );
  await expect(gitRead(root, ["status"])).resolves.toBe("0|1|diff.autoRefreshIndex|false");
});

test("a deadline kills a push whose hook hangs, and the hook dies with it", async () => {
  const repo = initRepo(join(root, "repo"), "main");
  const origin = join(root, "origin.git");
  runGit(root, "clone", "--bare", repo, origin);
  const pidFile = join(root, "hook.pid");
  writeFileSync(
    join(repo, ".git/hooks/pre-push"),
    `#!/bin/sh\necho $$ > "${pidFile}"\nsleep 30\n`,
    { mode: 0o755 },
  );
  chmodSync(join(repo, ".git/hooks/pre-push"), 0o755);

  const started = Date.now();
  await expect(
    git(repo, ["push", "--porcelain", "--", origin, "refs/heads/main:refs/heads/main"], {
      timeoutMs: 800,
    }),
  ).rejects.toThrow(/did not finish within 800 ms/);
  // The pipe is not what bounds the call: the process group is.
  expect(Date.now() - started).toBeLessThan(5000);
  expect(existsSync(pidFile)).toBe(true);
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  const deadline = Date.now() + 3000;
  const running = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  while (running() && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- waiting for the hook to die is the point
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(running()).toBe(false);
});
