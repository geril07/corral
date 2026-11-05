import { vi } from "vite-plus/test";

export interface ClipboardStub {
  readonly writeText: ReturnType<typeof vi.fn>;
  restore(): void;
}

/** Put back the platform's own property (or remove the stub) after a test. */
function replaceClipboard(value: unknown): () => void {
  const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value,
  });
  return () => {
    if (original === undefined) Reflect.deleteProperty(navigator, "clipboard");
    else Object.defineProperty(navigator, "clipboard", original);
  };
}

/**
 * Browser Mode grants no clipboard permission, so the test owns the answer. `restore` puts the
 * platform's property (or none) back after the test.
 */
export function stubClipboard(write: (text: string) => Promise<void>): ClipboardStub {
  const writeText = vi.fn<(text: string) => Promise<void>>(write);
  return { writeText, restore: replaceClipboard({ writeText }) };
}

/** A host with no clipboard API at all; the header must show a refusal, not pretend to copy. */
export function removeClipboard(): { restore(): void } {
  return { restore: replaceClipboard(undefined) };
}
