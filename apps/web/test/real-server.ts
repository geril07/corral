import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vite-plus/test/node";
// The one place web code reaches into the server: browser tests run against the real thing.
import { SERVER_TARGET_KEY } from "./server-url-key.ts";
import { startServer } from "../../server/src/transport/server.ts";
import { removeGitRepos } from "./git-repos.ts";
import { useFakeIssueClis } from "./issue-clis.ts";
import { useFakeAgents } from "./server-agents.ts";

/** Vitest global setup: one real server per run; tests clear its terminals between them. */
export default async function setup(project: TestProject) {
  // Terminals created without a command run $SHELL; a plain sh keeps prompts predictable.
  process.env.SHELL = "/bin/sh";
  // The server reads $CORRAL_CONFIG_DIR; never the developer's own ~/.config/corral.
  const configDir = mkdtempSync(join(tmpdir(), "corral-web-config-"));
  process.env["CORRAL_CONFIG_DIR"] = configDir;
  const removeAgents = useFakeAgents();
  const removeIssueClis = useFakeIssueClis();
  const server = await startServer({ host: "127.0.0.1", port: 0 });
  // The provided-context interface can only be augmented through the vitest package, which
  // apps/web does not depend on directly, so its keys are typed `never` here.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  const key = SERVER_TARGET_KEY as never;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
  project.provide(key, { url: server.url, capability: server.capability } as never);
  return async () => {
    await server.close();
    rmSync(configDir, { recursive: true, force: true });
    removeGitRepos();
    removeIssueClis();
    removeAgents();
  };
}
