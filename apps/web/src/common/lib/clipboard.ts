/** What one copy attempt produced: the confirmation, or the host's refusal sentence. */
export interface CopyOutcome {
  outcome: "copied" | "refused";
  message: string;
}

/** The host's own refusal sentence, or ours when the clipboard is absent. */
function clipboardRefusal(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "Clipboard access is unavailable.";
}

/** One clipboard write and its confirmation; a refusal is a sentence, never a silent copy. */
export async function copyText(text: string, copied: string): Promise<CopyOutcome> {
  try {
    const clipboard = navigator.clipboard;
    if (clipboard === undefined) throw new Error("Clipboard access is unavailable.");
    await clipboard.writeText(text);
    return { outcome: "copied", message: copied };
  } catch (error) {
    return { outcome: "refused", message: clipboardRefusal(error) };
  }
}
