/** Builders for OSC 7501 sequences, so tests say what a program reports and not how it is encoded. */

export interface ReportFields {
  state: string;
  id?: string;
  kind?: string;
  msg?: string;
}

/** The body between `OSC 7501;` and the terminator, with `msg` as base64 like the spec wants. */
export function reportBody({ state, id, kind, msg }: ReportFields): string {
  return [
    `state=${state}`,
    id !== undefined && `id=${id}`,
    kind !== undefined && `kind=${kind}`,
    msg !== undefined && `msg=${Buffer.from(msg, "utf8").toString("base64")}`,
  ]
    .filter(Boolean)
    .join(":");
}

export function report(fields: ReportFields, terminator: "st" | "bel" = "st"): string {
  return `\x1b]7501;${reportBody(fields)}${terminator === "st" ? "\x1b\\" : "\x07"}`;
}

export const PROBE = "\x1b]7501;?\x1b\\";
