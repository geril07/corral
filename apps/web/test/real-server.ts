import type { TestProject } from "vite-plus/test/node";
// The one place web code reaches into the server: browser tests run against the real thing.
import { SERVER_URL_KEY } from "./server-url-key.ts";
import { startServer } from "../../server/src/transport/server.ts";

/** Vitest global setup: one real server per run; tests clear its terminals between them. */
export default async function setup(project: TestProject) {
  // Terminals created without a command run $SHELL; a plain sh keeps prompts predictable.
  process.env.SHELL = "/bin/sh";
  const server = await startServer({ host: "127.0.0.1", port: 0 });
  // The provided-context interface can only be augmented through the vitest package, which
  // apps/web does not depend on directly, so its keys are typed `never` here.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  project.provide(SERVER_URL_KEY as never, server.url as never);
  return () => server.close();
}
