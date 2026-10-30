import type { TerminalSurface } from "../src/terminal-stream.ts";
import { createRequire } from "node:module";
import type { Terminal } from "@xterm/headless";

const require = createRequire(import.meta.url);
const { Terminal: XtermTerminal }: typeof import("@xterm/headless") = require("@xterm/headless");

/** What xterm.js is to the browser: a headless terminal the stream writes into, with test hooks. */
export class TestTerminal implements TerminalSurface {
  readonly terminal: Terminal;
  /** How many times the screen was replaced by a snapshot. */
  resets = 0;
  /** Bytes of output that the terminal has parsed (snapshots excluded). */
  parsedOutputBytes = 0;
  #stalled = false;
  #held: (() => void)[] = [];

  constructor() {
    this.terminal = new XtermTerminal({
      cols: 80,
      rows: 24,
      scrollback: 5000,
      allowProposedApi: true,
      logLevel: "off",
    });
  }

  get size() {
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  /** Text of the active buffer, scrollback included, trailing blank rows dropped. */
  get screen(): string[] {
    const buffer = this.terminal.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < buffer.length; row++)
      lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
    while (lines.at(-1) === "") lines.pop();
    return lines;
  }

  /** A slow terminal: output is parsed but its write callbacks (the acks) wait for `release`. */
  stall(): void {
    this.#stalled = true;
  }

  release(): void {
    this.#stalled = false;
    for (const callback of this.#held.splice(0)) callback();
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    const isOutput = typeof data !== "string" && data.length > 0;
    this.terminal.write(data, () => {
      if (isOutput) this.parsedOutputBytes += data.length;
      if (!callback) return;
      if (isOutput && this.#stalled) this.#held.push(callback);
      else callback();
    });
  }

  reset(): void {
    this.resets += 1;
    this.terminal.reset();
  }

  resize(cols: number, rows: number): void {
    this.terminal.resize(cols, rows);
  }
}
