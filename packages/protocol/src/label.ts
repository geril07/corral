import { z } from "zod";

/** Long enough for a sentence about what runs where, short enough for a sidebar row. */
export const MAX_LABEL_LENGTH = 80;

/**
 * A user-facing name for a session or a loose terminal. It is only ever shown, never used to
 * build a command, an environment variable or a path.
 */
export const Label = z
  .string()
  .trim()
  .max(MAX_LABEL_LENGTH)
  .refine((label) => !/\p{Cc}/u.test(label), "a label has no control characters");
export type Label = z.infer<typeof Label>;

/** Trimmed; blank means "no label", so the natural name comes back. */
export function normalizeLabel(label: string | null | undefined): string | null {
  const trimmed = label?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}
