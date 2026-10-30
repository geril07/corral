import { randomBytes } from "node:crypto";
import { statSync, unlinkSync } from "node:fs";
import path from "node:path";

/** A directory entry is identified by dev+ino; names alone say nothing about who made a file. */
export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export function identityOf(filePath: string): FileIdentity {
  const { dev, ino } = statSync(filePath, { bigint: true });
  return { dev, ino };
}

export function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Only positive evidence of loss is `lost`; anything unreadable is `indeterminate`. */
export type Ownership = "owned" | "lost" | "indeterminate";

export function ownershipOf(filePath: string, identity: FileIdentity): Ownership {
  try {
    return sameFile(identityOf(filePath), identity) ? "owned" : "lost";
  } catch (error) {
    return isErrno(error, "ENOENT") ? "lost" : "indeterminate";
  }
}

/** Nobody removes a file they did not create: remove only while the entry is still ours. */
export function removeIfOwned(filePath: string, identity: FileIdentity): void {
  if (ownershipOf(filePath, identity) !== "owned") return;
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

/** A private name next to `target`, so a scratch file can be renamed or linked atomically. */
export function scratchPathNextTo(target: string, label: string): string {
  return path.join(
    path.dirname(target),
    `.${label}-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
}

export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
