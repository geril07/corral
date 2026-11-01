import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { initRepo, runGit } from "../../test/git-repo.ts";
import { useServer } from "../../test/server-fixture.ts";

// A root of its own and a branch prefix, the way A0's settings will supply them.
const server = useServer({
  taskSettings: ({ scratchDir }) => ({
    worktreeRoot: () => join(scratchDir, "worktrees"),
    branchPrefix: () => "corral/",
    slugMode: () => "title",
    view: () => "terminal",
  }),
});

test("the worktree root and branch prefix come from settings; a taken name numbers branch and directory", async () => {
  const repo = initRepo(join(server.scratchDir, "app"));
  const api = await server.rpc();
  const project = await api.projects.add({ path: repo });
  const create = () =>
    api.tasks.create({
      projectId: project.id,
      title: "Fix login",
      workspace: { type: "new-branch" },
    });

  const first = await create();
  const second = await create();

  const root = join(server.scratchDir, "worktrees");
  expect(first).toMatchObject({
    branch: "corral/fix-login",
    workspacePath: join(root, "app", "fix-login"),
  });
  expect(second).toMatchObject({
    branch: "corral/fix-login-2",
    workspacePath: join(root, "app", "fix-login-2"),
  });
  expect(runGit(first.workspacePath, "branch", "--show-current").trim()).toBe("corral/fix-login");
});

test("two projects with the same directory name share <root>/<repo> and stay apart by suffix", async () => {
  const api = await server.rpc();
  const one = await api.projects.add({ path: initRepo(join(server.scratchDir, "one", "app")) });
  const two = await api.projects.add({ path: initRepo(join(server.scratchDir, "two", "app")) });
  const create = (projectId: string) =>
    api.tasks.create({ projectId, title: "Same name", workspace: { type: "new-branch" } });

  const first = await create(one.id);
  const second = await create(two.id);

  const projectDir = join(server.scratchDir, "worktrees", "app");
  expect([first.workspacePath, second.workspacePath]).toEqual([
    join(projectDir, "same-name"),
    join(projectDir, "same-name-2"),
  ]);
});

test("a local branch the prefix would sit under fails with that conflict and leaves nothing behind", async () => {
  const repo = initRepo(join(server.scratchDir, "blocked"));
  runGit(repo, "branch", "corral");
  const api = await server.rpc();
  const project = await api.projects.add({ path: repo });

  await expect(
    api.tasks.create({
      projectId: project.id,
      title: "Fix login",
      workspace: { type: "new-branch" },
    }),
  ).rejects.toMatchObject({
    code: "GIT_FAILED",
    data: { message: "a branch named 'corral' blocks every branch under the prefix 'corral/'" },
  });

  const worktrees = runGit(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
  expect(worktrees).toEqual([`worktree ${repo}`]);
});
