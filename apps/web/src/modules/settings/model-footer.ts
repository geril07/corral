export interface ModelFooterState {
  busy: boolean;
  dirty: boolean;
  revision: number;
}

/** The one footer line: an in-flight save outranks the draft it will commit. */
export function modelFooterText({ busy, dirty, revision }: ModelFooterState): string {
  if (busy) return "Saving…";
  return `${dirty ? "Unsaved changes" : "Saved"} · revision ${revision}`;
}
