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

/** A project with one task whose workspace is a new worktree, or the repository itself with `main-worktree`. */
export async function addTask(
  server: ReturnType<typeof useServer>,
  title: string,
  workspace: "new-branch" | "main-worktree" = "new-branch",
) {
  const { project, repo } = await addProject(server);
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    title,
    workspace: { type: workspace },
  });
  return { api, project, repo, task };
}
