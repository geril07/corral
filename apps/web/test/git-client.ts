import { commands } from "vite-plus/test/browser";

type RunGitIn = (directory: string, args: string[]) => Promise<string>;

/** Runs git in the test run's Node process against a path the server gave the test. */
export function runGitIn(directory: string, args: string[]): Promise<string> {
  // Custom commands are not part of the library's types, which this package cannot augment.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const run = (commands as unknown as { runGitIn: RunGitIn }).runGitIn;
  return run(directory, args);
}
