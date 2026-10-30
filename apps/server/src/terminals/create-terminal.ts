import type { CreateTerminalInput, Task, TerminalInfo } from "@corral/protocol/rpc";
import type { TerminalRegistry } from "./terminal-registry.ts";

export class InvalidTerminalRequestError extends Error {}

/** A terminal for a task starts in the task's workspace; `taskId` and `cwd` together are ambiguous. */
export function createTerminal(
  terminals: TerminalRegistry,
  findTask: (id: string) => Task,
  input: CreateTerminalInput,
): TerminalInfo {
  if (input.taskId === undefined) return terminals.create(input);
  if (input.cwd !== undefined)
    throw new InvalidTerminalRequestError("taskId and cwd cannot be given together");
  return terminals.create({ ...input, cwd: findTask(input.taskId).workspacePath });
}
