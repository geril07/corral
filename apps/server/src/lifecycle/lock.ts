import {
  closeSync,
  fstatSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { uptime } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  identityOf,
  isErrno,
  ownershipOf,
  removeIfOwned,
  sameFile,
  scratchPathNextTo,
  type FileIdentity,
  type Ownership,
} from "./owned-file.ts";

const LockContent = z.object({ pid: z.number().int().positive(), startedAt: z.number() });
type LockContent = z.infer<typeof LockContent>;

/**
 * A process that started this long before the last boot cannot have survived it, so a live
 * pid in such a lock belongs to someone else. The margin absorbs wall-clock adjustments.
 */
const BOOT_MARGIN_MS = 60_000;
const ACQUIRE_ATTEMPTS = 5;

export function lockFilePath(stateDir: string): string {
  return path.join(stateDir, "server.lock");
}

export interface HeldLock {
  ownership(): Ownership;
  /** Removes the lock only while it is still ours. */
  release(): void;
}

export type AcquireResult =
  | { status: "acquired"; lock: HeldLock }
  | { status: "refused"; reason: string };

/**
 * Single-instance lock: a file holding `{ pid, startedAt }`, published with `link` so it is
 * never visible half-written and never replaces an existing lock. An existing lock is only
 * replaced on positive proof its holder is dead; "cannot tell" refuses.
 */
export function acquireLock(stateDir: string): AcquireResult {
  const lockPath = lockFilePath(stateDir);
  const scratch = scratchPathNextTo(lockPath, "lock");
  const mine: LockContent = { pid: process.pid, startedAt: Date.now() };
  writeFileSync(scratch, JSON.stringify(mine), { flag: "wx" });
  try {
    const identity = identityOf(scratch);
    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
      try {
        linkSync(scratch, lockPath);
        return { status: "acquired", lock: heldLock(lockPath, identity) };
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
      }
      const incumbent = judgeIncumbent(lockPath);
      if (incumbent.kind === "refuse") return { status: "refused", reason: incumbent.reason };
      if (incumbent.kind === "gone" || !stillProvenDead(lockPath, incumbent)) continue;
      // One rename replaces the entry, so the lock is never absent (an absent lock reads as
      // "lost" to a concurrent starter). POSIX has no rename-if-target-is-X: if another starter
      // replaced the dead lock first, the later rename wins and the earlier one finds out in
      // the ownership check below, or in the server's own checks.
      renameSync(scratch, lockPath);
      return ownershipOf(lockPath, identity) === "owned"
        ? { status: "acquired", lock: heldLock(lockPath, identity) }
        : { status: "refused", reason: `lost the race for lock ${lockPath}; not starting` };
    }
    return { status: "refused", reason: `lock ${lockPath} kept changing hands; not starting` };
  } finally {
    rmSync(scratch, { force: true });
  }
}

function heldLock(lockPath: string, identity: FileIdentity): HeldLock {
  return {
    ownership: () => ownershipOf(lockPath, identity),
    release: () => removeIfOwned(lockPath, identity),
  };
}

interface ProvenDead {
  readonly kind: "dead";
  readonly identity: FileIdentity;
  readonly raw: string;
}

type Incumbent = ProvenDead | { kind: "gone" } | { kind: "refuse"; reason: string };

function judgeIncumbent(lockPath: string): Incumbent {
  let fd: number;
  try {
    fd = openSync(lockPath, "r");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return { kind: "gone" };
    throw error;
  }
  try {
    const { dev, ino } = fstatSync(fd, { bigint: true });
    const raw = readFileSync(fd, "utf8");
    const parsed = LockContent.safeParse(safeJson(raw));
    if (!parsed.success) {
      return {
        kind: "refuse",
        reason: `lock ${lockPath} is unreadable; remove it if no server runs`,
      };
    }
    const holder = parsed.data;
    const state = holderState(holder);
    if (state === "dead") return { kind: "dead", identity: { dev, ino }, raw };
    return {
      kind: "refuse",
      reason:
        state === "alive"
          ? `another server is running (pid ${holder.pid}, lock ${lockPath})`
          : `cannot tell whether pid ${holder.pid} of lock ${lockPath} is alive`,
    };
  } finally {
    closeSync(fd);
  }
}

/** Judge again: liveness seen at T must still hold for the same entry at T+1. */
function stillProvenDead(lockPath: string, proven: ProvenDead): boolean {
  const again = judgeIncumbent(lockPath);
  return (
    again.kind === "dead" && sameFile(again.identity, proven.identity) && again.raw === proven.raw
  );
}

type HolderState = "alive" | "dead" | "unknown";

function holderState(holder: LockContent): HolderState {
  const pid = pidState(holder.pid);
  if (pid !== "alive") return pid;
  const bootedAt = Date.now() - uptime() * 1000;
  return holder.startedAt < bootedAt - BOOT_MARGIN_MS ? "dead" : "alive";
}

function pidState(pid: number): HolderState {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (isErrno(error, "ESRCH")) return "dead";
    // EPERM: the process exists but belongs to someone else.
    return isErrno(error, "EPERM") ? "alive" : "unknown";
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
