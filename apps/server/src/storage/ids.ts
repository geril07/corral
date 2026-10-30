import { randomBytes } from "node:crypto";

/** 12 hex digits: short enough to read in a path, wide enough that collisions do not happen on one machine. */
export function newId(): string {
  return randomBytes(6).toString("hex");
}
