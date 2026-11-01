/**
 * A plain JSON object. Journals, fake HTTP bodies and recorded snapshots are `unknown` after
 * `JSON.parse`; this narrows them without asserting `any` into a shape.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
