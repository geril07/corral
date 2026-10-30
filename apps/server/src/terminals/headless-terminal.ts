import type { TerminalSize } from "@corral/protocol/rpc";
import type { SerializeAddon as SerializeAddonType } from "@xterm/addon-serialize";
import type { Terminal } from "@xterm/headless";
import { createRequire } from "node:module";

// The xterm packages are CommonJS: Node's ESM loader exposes only a default export for them.
const require = createRequire(import.meta.url);
const { Terminal: XtermTerminal }: typeof import("@xterm/headless") = require("@xterm/headless");
const {
  SerializeAddon,
}: typeof import("@xterm/addon-serialize") = require("@xterm/addon-serialize");

export const SCROLLBACK_ROWS = 5000;

/**
 * Private xterm state the public API does not expose but a snapshot needs. Optional because an
 * xterm upgrade can move it; a missing field degrades the snapshot, it does not break it.
 */
interface XtermInternals {
  _core?: {
    coreService?: { isCursorHidden?: boolean };
    mouseStateService?: { activeEncoding?: string };
    buffer?: {
      savedX?: number;
      savedY?: number;
      savedOriginMode?: boolean;
      ybase?: number;
      scrollTop?: number;
      scrollBottom?: number;
    };
  };
}

/** An `@xterm/headless` terminal that can describe itself as VT data for a client to replay. */
export class HeadlessTerminal {
  readonly #terminal: Terminal;
  readonly #serializer: SerializeAddonType;

  constructor(size: TerminalSize) {
    this.#terminal = new XtermTerminal({
      cols: size.cols,
      rows: size.rows,
      scrollback: SCROLLBACK_ROWS,
      allowProposedApi: true,
      logLevel: "off",
    });
    this.#serializer = new SerializeAddon();
    this.#terminal.loadAddon(this.#serializer);
  }

  get size(): TerminalSize {
    return { cols: this.#terminal.cols, rows: this.#terminal.rows };
  }

  /** `done` runs once the bytes (and everything written before them) have been parsed. */
  write(data: Uint8Array | string, done: () => void): void {
    this.#terminal.write(data, done);
  }

  resize(size: TerminalSize): void {
    this.#terminal.resize(size.cols, size.rows);
  }

  dispose(): void {
    this.#terminal.dispose();
  }

  /**
   * VT data that rebuilds scrollback, the active screen (alternate screen included), cursor and
   * modes on a reset terminal of `size`. The addon serializes the normal buffer, then
   * `ESC[?1049h` and the alternate buffer, plus most modes. Ported from Orca's
   * `headless-emulator.ts` (MIT): what the addon omits (mouse encoding, cursor visibility,
   * scroll region, saved cursor) is appended here, and the cursor is placed absolutely because
   * the addon's relative moves drift after a wrap-pending row.
   */
  snapshot(): string {
    const terminal = this.#terminal;
    // oxlint-disable-next-line no-underscore-dangle -- private xterm state, see XtermInternals
    const core = (terminal as Terminal & XtermInternals)._core;
    const serialized = this.#serializer.serialize();

    const encoding = core?.mouseStateService?.activeEncoding;
    const mouseEncoding =
      encoding === "SGR" ? "\x1b[?1006h" : encoding === "SGR_PIXELS" ? "\x1b[?1016h" : "";
    const cursorHidden = core?.coreService?.isCursorHidden === true ? "\x1b[?25l" : "";
    return `${serialized}${mouseEncoding}${cursorHidden}${this.#restoreCursorAndMargins(core?.buffer)}`;
  }

  #restoreCursorAndMargins(buffer: NonNullable<XtermInternals["_core"]>["buffer"]): string {
    const { cols, rows } = this.#terminal;
    const { cursorX, cursorY } = this.#terminal.buffer.active;
    const originMode = this.#terminal.modes.originMode;
    const scrollTop = buffer?.scrollTop ?? 0;
    const scrollBottom = buffer?.scrollBottom ?? rows - 1;
    const cupY = cursorY - (originMode ? scrollTop : 0);
    // A wrap-pending cursor sits at x == cols; CUP would clamp it and change where the next byte lands.
    const canPlaceCursor = cursorX >= 0 && cursorX < cols && cupY >= 0 && cupY < rows;

    // A later DECRC from the application must land on its saved cell, not on home.
    let saved = "";
    if (
      buffer &&
      typeof buffer.savedX === "number" &&
      typeof buffer.savedY === "number" &&
      typeof buffer.ybase === "number"
    ) {
      const y = Math.min(Math.max(buffer.savedY - buffer.ybase, 0), rows - 1);
      const x = Math.min(Math.max(buffer.savedX, 0), cols - 1);
      const savedOrigin = buffer.savedOriginMode === true;
      if (x !== 0 || y !== 0 || savedOrigin) {
        saved = `\x1b[r\x1b[?6${savedOrigin ? "h" : "l"}\x1b[${y + 1};${x + 1}H\x1b7`;
      }
    }
    const margins =
      scrollTop !== 0 || scrollBottom !== rows - 1
        ? `\x1b[${scrollTop + 1};${scrollBottom + 1}r`
        : "";
    // DECSTBM homes the cursor and DECSC above moved it, so margins and origin mode come before the final CUP.
    const origin = saved || margins ? `\x1b[?6${originMode ? "h" : "l"}` : "";
    const cursor = canPlaceCursor ? `\x1b[${cupY + 1};${cursorX + 1}H` : "";
    return `${saved}${margins}${origin}${cursor}`;
  }
}
