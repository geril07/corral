/** The body of an OSC 7501 report as a fake agent's `osc` command takes it; `msg` is ASCII, sent as base64. */
export function reportBody(fields: { state: string; kind?: string; msg?: string }): string {
  return [
    `state=${fields.state}`,
    fields.kind !== undefined && `kind=${fields.kind}`,
    fields.msg !== undefined && `msg=${btoa(fields.msg)}`,
  ]
    .filter(Boolean)
    .join(":");
}
