/**
 * The draft left after a send is accepted, or `null` when the draft was not a pure insertion.
 *
 * `submitted` is the draft as it was when the user sent it. Text inserted before, between or
 * after the submitted text is kept. If the common prefix and the submitted suffix do not cover
 * `current`, the draft was replaced or edited in place, so the caller keeps it whole instead of
 * guessing what to remove.
 */
export function draftLeftAfterSend(current: string, submitted: string): string | null {
  let from = 0;
  while (from < submitted.length && submitted[from] === current[from]) from++;
  const rest = submitted.slice(from);
  if (current.length < submitted.length || !current.endsWith(rest)) return null;
  return current.slice(from, current.length - rest.length);
}
