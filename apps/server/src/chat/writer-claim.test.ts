import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { processExists } from "../../test/session-helpers.ts";
import { ChatLaunchError } from "./chat-errors.ts";
import { recordWriter, releasePreviousWriter, releaseWriter, writerPath } from "./writer-claim.ts";

let root: string;
const started: ChildProcess[] = [];
const SESSION = "session-1";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "corral-writer-"));
});

afterEach(async () => {
  for (const child of started) child.kill("SIGKILL");
  started.length = 0;
  await rm(root, { recursive: true, force: true });
});

/** A sleeping process in its own group, standing in for a pi the previous server left behind. */
function sleeper(): ChildProcess {
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  started.push(child);
  return child;
}

test("a recorded writer of the previous server is killed before the next one spawns", async () => {
  const previous = sleeper();
  const path = writerPath(root, SESSION);
  recordWriter(path, previous.pid!);
  expect(processExists(previous.pid!)).toBe(true);

  await releasePreviousWriter(path, { waitMs: 2000 });

  expect(processExists(previous.pid!)).toBe(false);
});

test("a record whose process is gone is removed without touching anything", async () => {
  const dead = sleeper();
  const pid = dead.pid!;
  dead.kill("SIGKILL");
  await new Promise((resolve) => dead.once("close", resolve));
  const path = writerPath(root, SESSION);
  recordWriter(path, pid);

  await releasePreviousWriter(path, { waitMs: 100 });

  expect(processExists(pid)).toBe(false);
});

test("a record from before the last boot is a reused pid and is never killed", async () => {
  const innocent = sleeper();
  const path = writerPath(root, SESSION);
  await mkdir(root, { recursive: true });
  // Older than the boot, so the pid cannot be a writer that survived it.
  await writeFile(path, JSON.stringify({ pid: innocent.pid, startedAt: 0 }));

  await releasePreviousWriter(path, { waitMs: 100 });

  expect(processExists(innocent.pid!)).toBe(true);
});

test("a recycled pid is not killed: the record's start time does not match the live process", async () => {
  const innocent = sleeper();
  const path = writerPath(root, SESSION);
  await mkdir(root, { recursive: true });
  // From this boot, but a start time that belongs to some other process.
  await writeFile(
    path,
    JSON.stringify({ pid: innocent.pid, startedAt: Date.now(), identity: "0" }),
  );

  await releasePreviousWriter(path, { waitMs: 100 });

  expect(processExists(innocent.pid!)).toBe(true);
});

test("a live pid whose start time cannot be read refuses the launch instead of guessing", async () => {
  const innocent = sleeper();
  const path = writerPath(root, SESSION);
  await mkdir(root, { recursive: true });
  await writeFile(
    path,
    JSON.stringify({ pid: innocent.pid, startedAt: Date.now(), identity: "12345" }),
  );

  await expect(
    releasePreviousWriter(path, { waitMs: 100, identityOfPid: () => null }),
  ).rejects.toBeInstanceOf(ChatLaunchError);
  expect(processExists(innocent.pid!)).toBe(true);
});

test("without a recorded start time the boot margin decides, and a current writer is killed", async () => {
  const previous = sleeper();
  const path = writerPath(root, SESSION);
  await mkdir(root, { recursive: true });
  // A record written on a platform without /proc: no identity, from this boot.
  await writeFile(
    path,
    JSON.stringify({ pid: previous.pid, startedAt: Date.now(), identity: null }),
  );

  await releasePreviousWriter(path, { waitMs: 2000 });

  expect(processExists(previous.pid!)).toBe(false);
});

test("an unreadable record is removed, and releasing one that is not there is a no-op", async () => {
  const path = writerPath(root, SESSION);
  await mkdir(root, { recursive: true });
  await writeFile(path, "not json");
  await releasePreviousWriter(path, { waitMs: 100 });

  recordWriter(path, process.pid);
  releaseWriter(path);
  releaseWriter(path);
  await releasePreviousWriter(path, { waitMs: 100 });
  expect(existsSync(path)).toBe(false);
});
