const ESC = 0x1b;
const CAN = 0x18;
const SUB = 0x1a;
const BEL = 0x07;

/** More than this and the sequence is abandoned: a runaway OSC must not grow every snapshot. */
const MAX_TAIL_BYTES = 4096;

type ScanState =
  | "ground"
  | "esc"
  | "escIntermediate"
  | "csi"
  | "osc"
  | "oscEsc"
  | "string"
  | "stringEsc";

function stateAfterEsc(byte: number): ScanState {
  if (byte === 0x5b) return "csi";
  if (byte === 0x5d) return "osc";
  if (byte === 0x50 || byte === 0x58 || byte === 0x5e || byte === 0x5f) return "string";
  if (byte >= 0x20 && byte <= 0x2f) return "escIntermediate";
  if (byte < 0x20) return "esc";
  return "ground";
}

/**
 * Bytes at the end of `stream` that a terminal parser has consumed but not completed: an
 * unfinished escape sequence, or a UTF-8 character cut short. A serialized snapshot cannot
 * carry parser state, so the server sends these bytes after it and the next live chunk
 * finishes them. Ported from Orca's `terminal-partial-escape-tail.ts` (MIT), on bytes.
 */
export function pendingInputTail(stream: Uint8Array): Uint8Array {
  let state: ScanState = "ground";
  let start = 0;
  for (let i = 0; i < stream.length; i++) {
    const byte = stream[i]!;
    if (state === "ground") {
      if (byte !== ESC) continue;
      start = i;
      state = "esc";
      continue;
    }
    if (
      byte === ESC &&
      state !== "osc" &&
      state !== "string" &&
      state !== "oscEsc" &&
      state !== "stringEsc"
    ) {
      start = i;
      state = "esc";
      continue;
    }
    switch (state) {
      case "esc":
        state = byte === CAN || byte === SUB ? "ground" : stateAfterEsc(byte);
        break;
      case "escIntermediate":
        if (byte === CAN || byte === SUB || (byte >= 0x30 && byte <= 0x7e)) state = "ground";
        break;
      case "csi":
        if (byte === CAN || byte === SUB || (byte >= 0x40 && byte <= 0x7e)) state = "ground";
        break;
      case "osc":
      case "string":
        if (byte === CAN || byte === SUB || (byte === BEL && state === "osc")) state = "ground";
        else if (byte === ESC) state = state === "osc" ? "oscEsc" : "stringEsc";
        break;
      case "oscEsc":
      case "stringEsc":
        if (byte === 0x5c) {
          state = "ground";
        } else {
          // The ESC ended the string and started a new sequence at the previous byte.
          start = byte === ESC ? i : i - 1;
          state =
            byte === ESC ? "esc" : byte === CAN || byte === SUB ? "ground" : stateAfterEsc(byte);
        }
        break;
    }
  }
  // xterm ends a string at ESC, so only the pending ESC is left to replay.
  if (state === "oscEsc" || state === "stringEsc") return Uint8Array.of(ESC);
  const tail = state === "ground" ? incompleteUtf8Tail(stream) : stream.slice(start);
  return tail.length > MAX_TAIL_BYTES ? new Uint8Array(0) : tail;
}

function incompleteUtf8Tail(stream: Uint8Array): Uint8Array {
  for (let back = 1; back <= Math.min(3, stream.length); back++) {
    const byte = stream[stream.length - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return length > back ? stream.slice(stream.length - back) : new Uint8Array(0);
  }
  return new Uint8Array(0);
}

/** Tracks the tail across chunks: the tail after `a + b` equals the tail of (tail after `a`) + `b`. */
export class PendingInputTail {
  #tail: Uint8Array = new Uint8Array(0);

  get bytes(): Uint8Array {
    return this.#tail;
  }

  push(chunk: Uint8Array): void {
    if (this.#tail.length === 0 && !chunk.includes(ESC)) {
      this.#tail = incompleteUtf8Tail(chunk);
      return;
    }
    const joined = new Uint8Array(this.#tail.length + chunk.length);
    joined.set(this.#tail);
    joined.set(chunk, this.#tail.length);
    this.#tail = pendingInputTail(joined);
  }
}
