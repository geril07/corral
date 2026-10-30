import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The server-side half of the browser command: a browser test cannot write the server's files. */
export function writeConfigFile(_context: unknown, text: string | null): string {
  const directory = process.env["CORRAL_CONFIG_DIR"];
  if (!directory) throw new Error("the test server has no CORRAL_CONFIG_DIR");
  const file = join(directory, "config.toml");
  if (text === null) {
    rmSync(file, { force: true });
  } else {
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, text);
  }
  return file;
}
