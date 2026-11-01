import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ChatLaunchError, messageOf } from "./chat-errors.ts";

const WriterRecord = z.object({ pid: z.number().int().positive(), startedAt: z.number() });
type WriterRecord = z.infer<typeof WriterRecord>;

/**
 * A process that started this long before the last boot cannot have survived it, so a live pid in
 * such a record belongs to someone else. The same margin as the server lock (`lifecycle/lock.ts`).
 */
const BOOT_MARGIN_MS = 60_000;
/** How long a recorded writer gets to die after SIGKILL before the launch is refused. */
const DEFAULT_WAIT_MS = 3000;
const POLL_MS = 20;

/**
 * Where the live pi process of a chat session is recorded, so a server that starts again can stop
 * the previous one before it spawns its own. Two writers corrupt a pi session file, so the launch
 * refuses to proceed if the recorded process cannot be proven gone.
 */
export function writerPath(chatDir: string, sessionId: string): string {
  return join(chatDir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
}

/** Records `pid` as the session's only writer. */
export function recordWriter(path: string, pid: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const record: WriterRecord = { pid, startedAt: Date.now() };
  writeFileSync(path, JSON.stringify(record));
}

/** Forgets the record; a process that is already gone leaves nothing to kill. */
export function releaseWriter(path: string): void {
  rmSync(path, { force: true });
}

/**
 * Stops the writer a previous server left behind, or waits until it is gone, before this server
 * spawns its own. Closing stdin is how pi is asked to shut down and it exits on EOF even mid-turn
 * (measured on pi 1.4.0, see the B1 report), but a server that died without closing its pipes, or a
 * pi that is stuck in a tool, still holds the session file: that process is killed with its group.
 */
export async function releasePreviousWriter(
  path: string,
  options: { waitMs?: number } = {},
): Promise<void> {
  const raw = readWriterFile(path);
  if (raw === undefined) return;
  rmSync(path, { force: true });
  const parsed = WriterRecord.safeParse(safeJson(raw));
  if (!parsed.success) return;
  const { pid, startedAt } = parsed.data;
  if (!isAlive(pid)) return;
  const bootedAt = Date.now() - uptime() * 1000;
  // A pid from before the last boot has been reused; killing it would hit an innocent process.
  if (startedAt < bootedAt - BOOT_MARGIN_MS) return;
  killGroup(pid);
  const gone = await waitUntilGone(pid, options.waitMs ?? DEFAULT_WAIT_MS);
  if (!gone)
    throw new ChatLaunchError(
      `the previous pi process (pid ${pid}) of this session did not stop; not starting a second writer`,
    );
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else, so it is alive all the same.
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function killGroup(pid: number): void {
  try {
    if (process.platform !== "win32") {
      process.kill(-pid, "SIGKILL");
      return;
    }
  } catch (error) {
    // The group is gone, or this platform has none; the process itself is the fallback.
    if (!(error instanceof Error && "code" in error)) throw error;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
      throw new ChatLaunchError(`cannot stop the previous pi process: ${messageOf(error)}`);
  }
}

async function waitUntilGone(pid: number, waitMs: number): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    // oxlint-disable-next-line no-await-in-loop -- polling a process that is going away is the point
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return !isAlive(pid);
}

function readWriterFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
