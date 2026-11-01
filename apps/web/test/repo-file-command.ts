import { commands } from "vite-plus/test/browser";

// Custom commands are not part of the library's types, which this package cannot augment.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const custom = commands as unknown as {
  writeRepoFile: (
    root: string,
    name: string,
    content: { text: string } | { base64: string },
  ) => Promise<void>;
};

/** Writes one file into a test repository, from the browser (see `test/repo-files.ts`). */
export const writeRepoFile = (
  root: string,
  name: string,
  content: { text: string } | { base64: string },
) => custom.writeRepoFile(root, name, content);
