import { commands } from "vite-plus/test/browser";

type WriteFilesIn = (directory: string, files: Record<string, string>) => Promise<void>;

/** Writes files into a task's worktree from the test run's Node process (see `write-files.ts`). */
export function writeFilesIn(directory: string, files: Record<string, string>): Promise<void> {
  // Custom commands are not part of the library's types, which this package cannot augment.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const write = (commands as unknown as { writeFilesIn: WriteFilesIn }).writeFilesIn;
  return write(directory, files);
}
