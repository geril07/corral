import { mkdirSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { cloneOfOrigin, initRepo, runGit } from "../../test/git-repo.ts";
import { useServer, within } from "../../test/server-fixture.ts";

const server = useServer();

test("add registers the repository, named after its directory", async () => {
  const repo = initRepo(join(server.scratchDir, "my-app"));
  const api = await server.rpc();

  const project = await api.projects.add({ path: repo });

  expect(project).toEqual({
    id: expect.stringMatching(/^[0-9a-f]{12}$/),
    name: "my-app",
    path: repo,
    defaultBaseBranch: "main",
  });
  expect(await api.projects.watch().then((updates) => updates.next())).toMatchObject({
    value: [project],
  });
});

test("add of a repository with no branch to start tasks from fails with GIT_FAILED", async () => {
  const repo = initRepo(join(server.scratchDir, "app"));
  runGit(repo, "checkout", "-q", "--detach");
  runGit(repo, "branch", "-q", "-D", "main");
  const api = await server.rpc();

  await expect(api.projects.add({ path: repo })).rejects.toMatchObject({
    code: "GIT_FAILED",
    data: { message: expect.stringContaining("no branch") },
  });
});

test("add from a subdirectory registers the repository root", async () => {
  const repo = initRepo(join(server.scratchDir, "app"));
  mkdirSync(join(repo, "src", "deep"), { recursive: true });
  const api = await server.rpc();

  const project = await api.projects.add({ path: join(repo, "src", "deep") });

  expect(project.path).toBe(repo);
});

test("add from a linked worktree registers the main working tree", async () => {
  const repo = initRepo(join(server.scratchDir, "app"));
  const linked = join(server.scratchDir, "linked");
  runGit(repo, "worktree", "add", "-b", "other", linked);
  const api = await server.rpc();

  const project = await api.projects.add({ path: linked });

  expect(project).toMatchObject({ name: "app", path: repo, defaultBaseBranch: "main" });
});

test("add outside a repository, in a missing directory or in a bare repository fails with NOT_A_GIT_REPOSITORY", async () => {
  const plain = join(server.scratchDir, "plain");
  mkdirSync(plain);
  const { origin } = cloneOfOrigin(join(server.scratchDir));
  const api = await server.rpc();

  for (const path of [plain, join(server.scratchDir, "missing"), origin]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one case at a time keeps failures readable
    await expect(api.projects.add({ path })).rejects.toMatchObject({
      code: "NOT_A_GIT_REPOSITORY",
      data: { path },
    });
  }
  expect(await api.projects.watch().then((updates) => updates.next())).toMatchObject({ value: [] });
});

test("adding the same repository again fails with PROJECT_EXISTS, also through a subdirectory or a linked worktree", async () => {
  const repo = initRepo(join(server.scratchDir, "app"));
  mkdirSync(join(repo, "src"));
  const linked = join(server.scratchDir, "linked");
  runGit(repo, "worktree", "add", "-b", "other", linked);
  const api = await server.rpc();
  const project = await api.projects.add({ path: repo });

  for (const path of [repo, join(repo, "src"), linked]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one case at a time keeps failures readable
    await expect(api.projects.add({ path })).rejects.toMatchObject({
      code: "PROJECT_EXISTS",
      data: { id: project.id },
    });
  }
});

test("adding a repository through a symlink registers its real path once", async () => {
  const repo = initRepo(join(server.scratchDir, "app"));
  const link = join(server.scratchDir, "link");
  symlinkSync(repo, link);
  const api = await server.rpc();

  expect((await api.projects.add({ path: link })).path).toBe(repo);
});

test("the default base branch is origin/HEAD's branch, whatever is checked out", async () => {
  const { clone } = cloneOfOrigin(server.scratchDir);
  runGit(clone, "switch", "-c", "scratch");
  const api = await server.rpc();

  expect((await api.projects.add({ path: clone })).defaultBaseBranch).toBe("trunk");
});

test("without origin/HEAD the default base branch is the checked-out branch", async () => {
  const { clone } = cloneOfOrigin(server.scratchDir);
  runGit(clone, "remote", "set-head", "origin", "--delete");
  runGit(clone, "switch", "-c", "scratch");
  const plain = initRepo(join(server.scratchDir, "plain"), "develop");
  const api = await server.rpc();

  expect((await api.projects.add({ path: clone })).defaultBaseBranch).toBe("scratch");
  expect((await api.projects.add({ path: plain })).defaultBaseBranch).toBe("develop");
});

test("branches lists local branches, then remote-tracking ones without origin/HEAD", async () => {
  const { clone } = cloneOfOrigin(server.scratchDir);
  runGit(clone, "branch", "feature/login");
  const api = await server.rpc();
  const project = await api.projects.add({ path: clone });

  expect(await api.projects.branches({ id: project.id })).toEqual([
    "feature/login",
    "trunk",
    "origin/release/1.0",
    "origin/trunk",
  ]);
});

test("branches fails with typed errors for an unknown project and for a repository that is gone", async () => {
  const repo = initRepo(join(server.scratchDir, "app"));
  const api = await server.rpc();
  const project = await api.projects.add({ path: repo });

  await expect(api.projects.branches({ id: "nope" })).rejects.toMatchObject({
    code: "PROJECT_NOT_FOUND",
    data: { id: "nope" },
  });
  await rm(repo, { recursive: true });
  await expect(api.projects.branches({ id: project.id })).rejects.toMatchObject({
    code: "GIT_FAILED",
  });
});

test("remove forgets the project, leaves the repository alone and tells watchers", async () => {
  const repo = initRepo(join(server.scratchDir, "app"));
  const api = await server.rpc();
  const updates = await api.projects.watch();
  const next = async () => (await within(updates.next(), "a projects update")).value;
  expect(await next()).toEqual([]);
  const project = await api.projects.add({ path: repo });
  expect(await next()).toEqual([project]);

  await api.projects.remove({ id: project.id });

  expect(await next()).toEqual([]);
  expect(runGit(repo, "log", "--oneline")).toContain("initial commit");
  await expect(api.projects.remove({ id: project.id })).rejects.toMatchObject({
    code: "PROJECT_NOT_FOUND",
  });
  await updates.return?.();
});

test("projects survive a server restart on the same data directory", async () => {
  const repo = initRepo(join(server.scratchDir, "app"));
  const project = await (await server.rpc()).projects.add({ path: repo });

  await server.restart();

  const api = await server.rpc();
  expect((await api.projects.watch().then((updates) => updates.next())).value).toEqual([project]);
  await expect(api.projects.add({ path: repo })).rejects.toMatchObject({ code: "PROJECT_EXISTS" });
});
