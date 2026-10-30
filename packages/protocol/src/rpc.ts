import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";

/** Control channel, served at `RPC_PATH` over WebSocket with oRPC. Terminal bytes go elsewhere. */
export const RPC_PATH = "/rpc";

export const TerminalId = z.string().min(1);

export const TerminalSize = z.object({
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});
export type TerminalSize = z.infer<typeof TerminalSize>;

export const TerminalExit = z.object({
  exitCode: z.number().int(),
  signal: z.number().int().optional(),
});
export type TerminalExit = z.infer<typeof TerminalExit>;

export const TerminalInfo = z.object({
  id: TerminalId,
  /** Executable and arguments the PTY runs. */
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  size: TerminalSize,
  /** Set once the process exits. An exited terminal stays listed until it is closed. */
  exit: TerminalExit.nullable(),
});
export type TerminalInfo = z.infer<typeof TerminalInfo>;

export const CreateTerminalInput = z.object({
  /** Defaults to the user's login shell (`$SHELL`). */
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  /** Defaults to the user's home directory. */
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  size: TerminalSize,
});
export type CreateTerminalInput = z.infer<typeof CreateTerminalInput>;

const terminalNotFound = { NOT_FOUND: { data: z.object({ id: TerminalId }) } };

export const contract = {
  terminals: {
    list: oc.output(z.array(TerminalInfo)),
    create: oc.input(CreateTerminalInput).output(TerminalInfo),
    /** Kills the process if it still runs and forgets the terminal. */
    close: oc
      .errors(terminalNotFound)
      .input(z.object({ id: TerminalId }))
      .output(z.void()),
    /** Yields the full list now and again after every change (create, exit, resize, close). */
    watch: oc.output(eventIterator(z.array(TerminalInfo))),
  },
};
export type Contract = typeof contract;
