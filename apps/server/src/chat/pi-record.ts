/**
 * pi's RPC records as they arrive on the child's stdout: strict JSONL, one object per LF-terminated
 * line (pi docs `rpc.md`, **Framing**). Everything here is deliberately untrusted: the fields are
 * read through guards, because a record comes from whatever pi version the user has installed.
 * The driver is hand-written against the documented protocol (no pi npm dependency), so this file
 * is the only place that knows its shapes.
 */

/** One record of pi's stdout, still untyped: `type` decides what the fields mean. */
export type PiRecord = Readonly<Record<string, unknown>>;

/** Anything on stdout that is not a JSON object: a parse failure the driver ends the frontend for. */
export class PiRecordError extends Error {
  constructor(line: string) {
    super(`pi wrote a line that is not a JSON record: ${excerpt(line)}`);
    this.name = "PiRecordError";
  }
}

/**
 * Splits stdout into records. Only LF ends a record, as pi documents: Node's `readline` also
 * splits on U+2028 and U+2029, which are valid inside a JSON string, so it is not used anywhere
 * here. A trailing CR is dropped so CRLF input reads the same.
 */
export class PiLineReader {
  #buffer = "";

  /** The complete records in `chunk`, in arrival order; a partial last line stays buffered. */
  push(chunk: string): PiRecord[] {
    this.#buffer += chunk;
    const records: PiRecord[] = [];
    let lineEnd = this.#buffer.indexOf("\n");
    while (lineEnd >= 0) {
      const line = stripCarriageReturn(this.#buffer.slice(0, lineEnd));
      this.#buffer = this.#buffer.slice(lineEnd + 1);
      // A blank line is framing noise, not a record; pi never sends one.
      if (line !== "") records.push(parseRecord(line));
      lineEnd = this.#buffer.indexOf("\n");
    }
    return records;
  }

  /** Whatever did not end in LF when the child closed: a truncated record is a parse failure too. */
  finish(): PiRecord[] {
    const rest = stripCarriageReturn(this.#buffer);
    this.#buffer = "";
    return rest === "" ? [] : [parseRecord(rest)];
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function parseRecord(line: string): PiRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new PiRecordError(line);
  }
  if (!isRecord(value) || typeof value["type"] !== "string") throw new PiRecordError(line);
  return value;
}

/** Whether a parsed JSON value is one of pi's record objects. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function excerpt(line: string): string {
  return JSON.stringify(line.length > 120 ? `${line.slice(0, 120)}…` : line);
}

/** The record's `type`, which every record has. */
export function typeOf(record: PiRecord): string {
  const type = record["type"];
  return typeof type === "string" ? type : "";
}

export function stringField(record: PiRecord, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" ? value : undefined;
}

export function numberField(record: PiRecord, field: string): number | undefined {
  const value = record[field];
  return typeof value === "number" ? value : undefined;
}

export function booleanField(record: PiRecord, field: string): boolean | undefined {
  const value = record[field];
  return typeof value === "boolean" ? value : undefined;
}

export function objectField(record: PiRecord, field: string): PiRecord | undefined {
  const value = record[field];
  return isRecord(value) ? value : undefined;
}

export function arrayField(record: PiRecord, field: string): unknown[] | undefined {
  const value = record[field];
  return Array.isArray(value) ? value : undefined;
}

/** The objects of an array field, dropping anything that is not one. */
export function recordsField(record: PiRecord, field: string): PiRecord[] {
  return (arrayField(record, field) ?? []).filter(isRecord);
}

export function stringsField(record: PiRecord, field: string): string[] {
  return (arrayField(record, field) ?? []).filter(
    (entry): entry is string => typeof entry === "string",
  );
}

/** The text of a pi content array (`[{type:"text", text}]`), joined with a newline. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const text = block["text"];
    if (typeof text === "string") parts.push(text);
  }
  return parts.join("\n");
}

/** One command pi's stdin takes; `id` is echoed by its response. */
export function command(id: string, type: string, fields: Record<string, unknown> = {}): PiRecord {
  return { id, type, ...fields };
}
