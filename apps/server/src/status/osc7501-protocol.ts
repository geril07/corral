// Parsing and limits of the Program Status Protocol (OSC 7501), ported from Orca's
// `src/shared/program-status/protocol.ts` (MIT, Copyright (c) 2026 Lovecast Inc.).
// Spec: https://www.superlogical.com/rex/docs/build/program-status
import { AgentState, AgentStatus } from "@corral/protocol/rpc";

export const OSC_ID = 7501;

const STATES = AgentState.options;
const KINDS = AgentStatus.shape.kind.unwrap().options;

/** The only bytes the terminal ever writes back, and only for the `?` probe. */
export const QUERY_REPLY = `\x1b]7501;?:states=${STATES.join(",")}:kinds=${KINDS.join(",")}\x1b\\`;

/** Whole sequence cap, OSC through ST. */
const MAX_SEQUENCE_BYTES = 4096;
const MAX_BODY_LENGTH = MAX_SEQUENCE_BYTES - "\x1b]7501;".length - 1;
const MAX_KEY_LENGTH = 16;
const MAX_MSG_ENCODED = 2732;
const MAX_MSG_DECODED = 2048;
const MAX_TITLE_ENCODED = 256;
const MAX_TITLE_DECODED = 192;
const MAX_ID_LENGTH = 128;
const MAX_ID_DEPTH = 8;
const MAX_APP_LENGTH = 32;

export interface Osc7501Report {
  /** Null addresses the root record. */
  id: string | null;
  state: AgentState | "clear";
  kind?: NonNullable<AgentStatus["kind"]>;
  msg?: string;
}

export type Osc7501Message = { type: "query" } | { type: "report"; report: Osc7501Report };

const KEY = /^[a-z]+$/;
const VALUE = /^[A-Za-z0-9_.,+/=-]*$/;
const ID_SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
// oxlint-disable-next-line no-control-regex -- the spec refuses decoded C0/DEL/C1 controls
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const utf8 = new TextDecoder("utf-8", { fatal: true });

function isState(value: string): value is AgentState {
  return STATES.some((state) => state === value);
}

function isKind(value: string): value is NonNullable<AgentStatus["kind"]> {
  return KINDS.some((kind) => kind === value);
}

/** done and error outlive the program that reported them, so the user still finds the result. */
export function outlivesProgram(state: AgentState): boolean {
  return state === "done" || state === "error";
}

function isValidId(id: string): boolean {
  if (id.length > MAX_ID_LENGTH) return false;
  const segments = id.split("/");
  return segments.length <= MAX_ID_DEPTH && segments.every((segment) => ID_SEGMENT.test(segment));
}

/** Decoded single-line text, or null when the report must be discarded whole. */
function decodeText(encoded: string, maxEncoded: number, maxDecoded: number): string | null {
  // The encoded cap goes first: it bounds the work a hostile program can cause.
  if (encoded.length > maxEncoded || !BASE64.test(encoded)) return null;
  const unpadded = encoded.replace(/=+$/, "");
  if (unpadded.length % 4 === 1) return null;
  let binary: string;
  try {
    binary = atob(unpadded + "=".repeat((4 - (unpadded.length % 4)) % 4));
  } catch {
    return null;
  }
  if (binary.length > maxDecoded) return null;
  let text: string;
  try {
    text = utf8.decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
  return CONTROL.test(text) ? null : text;
}

/** Parses the body between `OSC 7501;` and ST. Null means ignore: no state, a bad id, a limit broken. */
export function parseBody(body: string): Osc7501Message | null {
  if (body.length > MAX_BODY_LENGTH) return null;
  if (body.trim() === "?") return { type: "query" };

  const pairs = new Map<string, string>();
  let msg: string | undefined;
  for (const pair of body.split(":")) {
    const equals = pair.indexOf("=");
    if (equals === -1) continue;
    const key = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1).trim();
    // A hard cap broken in any occurrence voids the report, even if a later duplicate is fine.
    if (
      key.length > MAX_KEY_LENGTH ||
      (key === "app" && value.length > MAX_APP_LENGTH) ||
      (key === "id" && !isValidId(value))
    ) {
      return null;
    }
    // Malformed pairs are skipped; the rest of the report still applies.
    if (!KEY.test(key) || !VALUE.test(value)) continue;
    if (key === "msg") {
      const text = decodeText(value, MAX_MSG_ENCODED, MAX_MSG_DECODED);
      if (text === null) return null;
      msg = text;
    } else if (key === "title") {
      // Not shown anywhere, but an over-limit title still voids the report.
      if (decodeText(value, MAX_TITLE_ENCODED, MAX_TITLE_DECODED) === null) return null;
    } else {
      pairs.set(key, value);
    }
  }

  const state = pairs.get("state");
  if (state === undefined || (state !== "clear" && !isState(state))) return null;
  const report: Osc7501Report = { id: pairs.get("id") ?? null, state };
  const kind = pairs.get("kind");
  if (state === "blocked" && kind !== undefined && isKind(kind)) report.kind = kind;
  if (msg) report.msg = msg;
  return { type: "report", report };
}
