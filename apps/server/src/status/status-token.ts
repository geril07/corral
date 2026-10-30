import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Random per launch of an agent; it proves a status report comes from that process (or a child of it). */
export function newStatusToken(): string {
  return randomBytes(32).toString("base64url");
}

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** Compares digests, so neither the content nor the length of the expected token leaks through timing. */
export function tokensEqual(expected: string, given: string): boolean {
  return timingSafeEqual(digest(expected), digest(given));
}
