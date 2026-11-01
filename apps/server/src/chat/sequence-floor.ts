import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * How many sequence numbers one chat frontend may use. A launch reserves a block before it spawns,
 * so every cursor a client can hold from that frontend lies below the next frontend's start — after
 * a server restart too, where no exit hook runs and the in-memory state is gone. A frontend that
 * emitted this many events would need the reservation raised while it runs; at a chat stream's
 * rate that is decades, and the exit hook raises it anyway.
 */
export const SEQUENCE_BLOCK = 2 ** 32;

const FloorRecord = z.object({ next: z.number().int().nonnegative() });

/** The persisted sequence floor of one session; beside the writer records in the data directory. */
export function floorPath(chatDir: string, sessionId: string): string {
  return join(chatDir, `${sessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.floor.json`);
}

/** The sequence a new frontend of this session starts at; 0 when nothing was recorded. */
export function readFloor(path: string): number {
  const raw = readFloorFile(path);
  if (raw === undefined) return 0;
  const parsed = FloorRecord.safeParse(safeJson(raw));
  return parsed.success ? parsed.data.next : 0;
}

/**
 * Reserves the next block for a frontend and returns the sequence its timeline starts at. Called
 * before the child spawns, so even a crash of this server cannot leave a client cursor that a
 * restarted timeline would accept as its own.
 */
export function reserveFloor(path: string): number {
  const startAt = readFloor(path);
  writeFloor(path, startAt + SEQUENCE_BLOCK);
  return startAt;
}

/** Raises the floor past what the frontend actually emitted; keeps the reservation honest. */
export function raiseFloor(path: string, next: number): void {
  if (next > readFloor(path)) writeFloor(path, next);
}

function writeFloor(path: string, next: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ next }));
}

function readFloorFile(path: string): string | undefined {
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
