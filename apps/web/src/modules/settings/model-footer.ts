export interface ModelFooterState {
  busy: boolean;
  dirty: boolean;
  loaded: boolean;
  failed: boolean;
  revision: number;
}

/**
 * The one footer line: an in-flight save outranks the draft it will commit, and an unloaded
 * preference list never claims a revision it does not have.
 */
export function modelFooterText({
  busy,
  dirty,
  loaded,
  failed,
  revision,
}: ModelFooterState): string {
  if (busy) return "Saving…";
  if (!loaded) return failed ? "Preferences unavailable" : "Loading preferences…";
  return `${dirty ? "Unsaved changes" : "Saved"} · revision ${revision}`;
}
