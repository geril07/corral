import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/** Whether `command` names a runnable file, as `execvp` would resolve it against `pathVariable`. */
export function isExecutable(command: string, pathVariable: string | undefined): boolean {
  const candidates =
    isAbsolute(command) || command.includes("/")
      ? [command]
      : (pathVariable ?? "")
          .split(delimiter)
          .filter((directory) => directory !== "")
          .map((directory) => join(directory, command));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}
