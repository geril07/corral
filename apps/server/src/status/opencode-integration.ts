import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_SOURCE = new URL("./opencode-plugin/index.js", import.meta.url);

/**
 * OpenCode reports through a plugin (`opencode-plugin/index.js`) that the server keeps in its
 * data directory and loads into the OpenCode processes it launches, so the user's own OpenCode
 * configuration is neither touched nor replaced.
 */
export class OpenCodeIntegration {
  readonly #pluginDir: string;
  #warned = false;

  /** Writes the plugin to `<dataDir>/agent-integrations/opencode/corral-status/index.js`, unless it is already there. */
  static install(dataDir: string): OpenCodeIntegration {
    const directory = join(dataDir, "agent-integrations", "opencode", "corral-status");
    const target = join(directory, "index.js");
    const source = readFileSync(PLUGIN_SOURCE);
    let current: Buffer | undefined;
    try {
      current = readFileSync(target);
    } catch {
      current = undefined;
    }
    if (!current?.equals(source)) {
      mkdirSync(directory, { recursive: true });
      const staging = `${target}.${process.pid}`;
      writeFileSync(staging, source);
      renameSync(staging, target);
    }
    return new OpenCodeIntegration(directory);
  }

  constructor(pluginDir: string) {
    this.#pluginDir = pluginDir;
  }

  /**
   * Arguments and environment that load the plugin into an OpenCode launched with `env`, or
   * undefined when the user configures OpenCode inline themselves (logged once).
   *
   * `--standalone` runs OpenCode's server inside the process. Without it the TUI is a client of
   * a shared background service, whose plugins live in that service: they would see its
   * environment, not the one of this session, and the service ignores a client's inline config.
   * `OPENCODE_CONFIG_CONTENT` merges with the user's configuration, `OPENCODE_CONFIG_DIR` would
   * replace the global one.
   */
  launch(env: NodeJS.ProcessEnv): { args: string[]; env: Record<string, string> } | undefined {
    if (env["OPENCODE_CONFIG_CONTENT"]) {
      if (!this.#warned) {
        this.#warned = true;
        console.warn(
          "corral-server: OPENCODE_CONFIG_CONTENT is set; OpenCode sessions will not report status",
        );
      }
      return undefined;
    }
    return {
      args: ["--standalone"],
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: [{ package: this.#pluginDir }] }) },
    };
  }
}
