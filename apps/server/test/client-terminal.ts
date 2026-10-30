/* oxlint-disable no-underscore-dangle, no-unsafe-type-assertion -- cursor visibility is not in the public API */
import type { TerminalSize } from "@corral/protocol/rpc";
import { createRequire } from "node:module";
import type { Terminal } from "@xterm/headless";

const require = createRequire(import.meta.url);
const { Terminal: XtermTerminal }: typeof import("@xterm/headless") = require("@xterm/headless");

/** Stands in for a client's xterm.js: a terminal the tests replay snapshots and output into. */
export function createClientTerminal(size: TerminalSize): Terminal {
  return new XtermTerminal({
    cols: size.cols,
    rows: size.rows,
    scrollback: 5000,
    allowProposedApi: true,
    logLevel: "off",
  });
}

export function writeAndWait(terminal: Terminal, data: Uint8Array | string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

type TerminalBuffer = Terminal["buffer"]["normal"];

function bufferLines(buffer: TerminalBuffer): string[] {
  const lines: string[] = [];
  for (let row = 0; row < buffer.length; row++)
    lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
  while (lines.at(-1) === "") lines.pop();
  return lines;
}

/** Everything a snapshot is meant to reproduce, in a form `toEqual` can compare. */
export function describeTerminal(terminal: Terminal) {
  const cursorHidden = (
    terminal as unknown as { _core: { coreService: { isCursorHidden: boolean } } }
  )._core.coreService.isCursorHidden;
  return {
    size: { cols: terminal.cols, rows: terminal.rows },
    activeBuffer: terminal.buffer.active.type,
    normal: bufferLines(terminal.buffer.normal),
    alternate:
      terminal.buffer.active.type === "alternate" ? bufferLines(terminal.buffer.alternate) : [],
    cursor: {
      x: terminal.buffer.active.cursorX,
      y: terminal.buffer.active.cursorY,
      hidden: cursorHidden,
    },
    modes: terminal.modes,
  };
}

/** Text of the active buffer, scrollback included, trailing blank rows dropped. */
export function screenLines(terminal: Terminal): string[] {
  return bufferLines(terminal.buffer.active);
}
