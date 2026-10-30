import { randomBytes } from "node:crypto";
import { tokensEqual } from "../status/status-token.ts";

/** Random per server run; it proves a socket comes from a holder of the endpoint file. */
export function newCapability(): string {
  return randomBytes(32).toString("base64url");
}

/** Constant-time; a wrong or missing capability is refused before any route is chosen. */
export function capabilityMatches(expected: string, given: string | undefined): boolean {
  return given !== undefined && given.length > 0 && tokensEqual(expected, given);
}
