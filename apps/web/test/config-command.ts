import { commands } from "vite-plus/test/browser";

// Custom commands are not part of the library's types, which this package cannot augment.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const custom = commands as unknown as {
  writeConfig: (text: string | null) => Promise<string>;
};

/**
 * Writes (`null`: deletes) the server's config file in the test's own `$CORRAL_CONFIG_DIR`
 * and returns its path. The server watches the file and pushes the change to its clients.
 */
export const writeConfig = (text: string | null) => custom.writeConfig(text);
