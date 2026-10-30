import { z } from "zod";
import { TerminalExit, TerminalSize } from "./rpc.ts";

/**
 * One WebSocket per attached terminal, at `terminalStreamPath(id)` with the protocol query
 * param. Binary frames carry raw bytes: PTY output from the server, keyboard input from the
 * client. Text frames carry the JSON messages below.
 *
 * Order on attach: `snapshot` first, then output bytes. Several clients may attach to one
 * terminal; the PTY has one size, set by the latest `resize` from any of them.
 *
 * Flow control is per client. The client acks output bytes once its terminal has processed
 * them (xterm.js `write` callback). A client with more than `ACK_WINDOW_BYTES` unacked stops
 * receiving output; once its unacked count falls to `ACK_RESUME_BYTES` it gets a fresh
 * `snapshot` instead of the bytes it missed; if the process exits first, that snapshot comes
 * right before `exit`. A slow client therefore never stalls the PTY or
 * the other clients, and the server never buffers unbounded output for it.
 */

export function terminalStreamPath(id: string): string {
  return `/terminals/${encodeURIComponent(id)}`;
}

/** Close code when the terminal id does not exist (or was closed while attached). */
export const TERMINAL_NOT_FOUND_CLOSE_CODE = 4004;

export const ACK_WINDOW_BYTES = 256 * 1024;
export const ACK_RESUME_BYTES = 64 * 1024;

export const ServerTerminalMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    size: TerminalSize,
    /**
     * VT data that reproduces the screen, scrollback, cursor and terminal modes when written
     * to a reset terminal of `size`. Snapshot bytes are not acked.
     */
    data: z.string(),
  }),
  z.object({ type: z.literal("resized"), size: TerminalSize }),
  /** Last message; the server then closes the socket with code 1000. */
  z.object({ type: z.literal("exit"), exit: TerminalExit }),
]);
export type ServerTerminalMessage = z.infer<typeof ServerTerminalMessage>;

export const ClientTerminalMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("resize"), size: TerminalSize }),
  z.object({ type: z.literal("ack"), bytes: z.number().int().positive() }),
]);
export type ClientTerminalMessage = z.infer<typeof ClientTerminalMessage>;
