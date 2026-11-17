import { vi } from "vite-plus/test";
import { cdp } from "vite-plus/test/browser";

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

export interface SystemClipboard {
  write(text: string): Promise<void>;
  read(): Promise<string>;
}

/**
 * The browser's own clipboard, for a test that has to see what a real copy or paste gesture did.
 * The test document is a frame of a page that never holds the OS focus, and `Clipboard` refuses
 * every call there; granting the permission to the whole browser context and going through the
 * focused top window is what reaches it.
 */
export function systemClipboard(): SystemClipboard {
  const top = window.top;
  if (top === null) throw new Error("the test document is not a frame");
  const granted = grantClipboard();
  return {
    async write(text) {
      await granted;
      await top.navigator.clipboard.writeText(text);
    },
    async read() {
      await granted;
      return top.navigator.clipboard.readText();
    },
  };
}

/** The grant is per browser context; a page-level grant never reaches the test's own frame. */
async function grantClipboard() {
  const { targetInfo } = await cdp().send("Target.getTargetInfo");
  const browserContextId = targetInfo.browserContextId;
  if (browserContextId === undefined) throw new Error("the page has no browser context");
  await cdp().send("Browser.grantPermissions", {
    browserContextId,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
}
