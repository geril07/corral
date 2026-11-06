/**
 * The draft left after a send is accepted, or `null` when the user edited it in place.
 *
 * `submitted` is the draft as it was when the user sent it. The longest common prefix is the
 * part the send consumed; whatever follows it in `current` is text typed since. If the rest of
 * the submitted draft no longer ends `current`, the draft was replaced or edited inside the
 * sent text, so the caller keeps it whole instead of guessing what to remove.
 */
export function draftLeftAfterSend(current: string, submitted: string): string | null {
  let from = 0;
  while (from < submitted.length && submitted[from] === current[from]) from++;
  const rest = submitted.slice(from);
  if (current.length < submitted.length || !current.endsWith(rest)) return null;
  return current.slice(from, current.length - rest.length);
}
