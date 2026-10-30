import type { Terminal } from "@xterm/xterm";

declare global {
  interface Window {
    /** Test hook: the visible terminal's text. The WebGL renderer draws to a canvas, so tests cannot read the DOM. */
    corralScreenText?: () => string;
  }
}

/** Publishes the terminal's text for tests; the returned function removes it again. */
export function publishScreenText(terminal: Terminal): () => void {
  const read = () => {
    const buffer = terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < buffer.length; row++)
      lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
    return lines.join("\n");
  };
  window.corralScreenText = read;
  return () => {
    if (window.corralScreenText === read) delete window.corralScreenText;
  };
}
