import { commands } from "vite-plus/test/browser";

type CreateGitRepo = (
  name: string,
  branches?: string[],
  files?: Record<string, string>,
) => Promise<string>;

/**
 * A git repository on `main` with one commit (and `files` in it), plus the given extra branches,
 * made by the test run's Node process (see `vite.config.ts`).
 */
export function createGitRepo(
  name: string,
  branches: string[] = [],
  files: Record<string, string> = {},
): Promise<string> {
  // Custom commands are not part of the library's types, which this package cannot augment.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const create = (commands as unknown as { createGitRepo: CreateGitRepo }).createGitRepo;
  return create(name, branches, files);
}
