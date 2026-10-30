import type { Project } from "@corral/protocol/rpc";
import { join } from "node:path";
import { initRepo } from "./git-repo.ts";
import type { useServer } from "./server-fixture.ts";

/** A repository named `name` in the test's scratch directory, added as a project. */
export async function addProject(
  server: ReturnType<typeof useServer>,
  name = "app",
): Promise<{ project: Project; repo: string }> {
  const repo = initRepo(join(server.scratchDir, name));
  const project = await (await server.rpc()).projects.add({ path: repo });
  return { project, repo };
}
