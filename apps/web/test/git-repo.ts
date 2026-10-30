import { commands } from "vite-plus/test/browser";

type CreateGitRepo = (name: string, branches?: string[]) => Promise<string>;

/** A git repository on `main` with one commit and the given extra branches, made by the test server side (see `vite.config.ts`). */
export function createGitRepo(name: string, branches: string[] = []): Promise<string> {
  // Custom commands are not part of the library's types, which this package cannot augment.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const create = (commands as unknown as { createGitRepo: CreateGitRepo }).createGitRepo;
  return create(name, branches);
}
