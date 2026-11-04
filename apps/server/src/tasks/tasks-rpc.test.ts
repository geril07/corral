import type { Task } from "@corral/protocol/rpc";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { cloneOfOrigin, commitFile, runGit, writeFiles } from "../../test/git-repo.ts";
import { addProject } from "../../test/project-fixture.ts";
import { useServer, within } from "../../test/server-fixture.ts";
import { launchesOf, sessionsOf } from "../../test/session-helpers.ts";
import { openDatabase } from "../storage/database.ts";
import { TaskStore } from "./task-store.ts";

const server = useServer();
const agents = useFakeAgents();
const SIZE = { cols: 80, rows: 24 };

const worktreePaths = (repo: string) =>
  runGit(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
const branches = (repo: string) =>
  runGit(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads")
    .split("\n")
    .filter(Boolean);

test("a new-branch task gets a branch named from its title, in a worktree under the data dir, off the default base", async () => {
  const { project, repo } = await addProject(server);
  commitFile(repo, "second.txt", "2\n");
  const api = await server.rpc();

  const task = await api.tasks.create({
    projectId: project.id,
    title: "Fix the login bug",
    workspace: { type: "new-branch" },
  });

  const expectedPath = join(server.dataDir, "worktrees", "app", "fix-the-login-bug");
  expect(task).toEqual({
    id: expect.any(String),
    projectId: project.id,
    title: "Fix the login bug",
    titleSource: "user",
    prompt: null,
    primarySessionId: null,
    branch: "fix-the-login-bug",
    workspacePath: expectedPath,
    ownsWorktree: true,
    state: "active",
    seenAt: null,
    createdAt: expect.any(Number),
  });
  expect(runGit(expectedPath, "branch", "--show-current").trim()).toBe("fix-the-login-bug");
  expect(runGit(expectedPath, "rev-parse", "HEAD")).toBe(runGit(repo, "rev-parse", "main"));
  expect(worktreePaths(repo)).toEqual([repo, expectedPath]);
});

test("a branch started from a remote-tracking branch does not track it", async () => {
  const { clone } = cloneOfOrigin(server.scratchDir);
  const api = await server.rpc();
  const project = await api.projects.add({ path: clone });

  const task = await api.tasks.create({
    projectId: project.id,
    title: "From remote",
    workspace: { type: "new-branch", baseBranch: "origin/release/1.0" },
  });

  expect(
    runGit(clone, "for-each-ref", "--format=%(upstream)", `refs/heads/${task.branch}`).trim(),
  ).toBe("");
});

test("new-branch off another base branch and with a branch name of the user's choice", async () => {
  const { project, repo } = await addProject(server);
  runGit(repo, "switch", "-c", "develop");
  commitFile(repo, "develop.txt", "d\n");
  runGit(repo, "switch", "main");
  const api = await server.rpc();

  const task = await api.tasks.create({
    projectId: project.id,
    title: "Anything",
    workspace: { type: "new-branch", branch: "feature/oauth", baseBranch: "develop" },
  });

  expect(task.branch).toBe("feature/oauth");
  expect(task.workspacePath).toBe(join(server.dataDir, "worktrees", "app", "feature-oauth"));
  expect(existsSync(join(task.workspacePath, "develop.txt"))).toBe(true);
});

test("tasks with the same title get -2, -3 branches and their own directories; existing branches are avoided", async () => {
  const { project, repo } = await addProject(server);
  runGit(repo, "branch", "fix-login");
  const api = await server.rpc();
  const create = () =>
    api.tasks.create({
      projectId: project.id,
      title: "Fix login",
      workspace: { type: "new-branch" },
    });

  const [first, second, third] = [await create(), await create(), await create()];

  expect([first.branch, second.branch, third.branch]).toEqual([
    "fix-login-2",
    "fix-login-3",
    "fix-login-4",
  ]);
  expect(new Set([first, second, third].map((task) => task.workspacePath)).size).toBe(3);
});

test("two tasks created at once do not fight over a name", async () => {
  const { project } = await addProject(server);
  const api = await server.rpc();
  const create = () =>
    api.tasks.create({ projectId: project.id, title: "Same", workspace: { type: "new-branch" } });

  const tasks = await Promise.all([create(), create(), create()]);

  expect(tasks.map((task) => task.branch).toSorted()).toEqual(["same", "same-2", "same-3"]);
});

test("a worktree directory that already exists is never reused", async () => {
  const { project } = await addProject(server);
  const occupied = join(server.dataDir, "worktrees", "app", "taken");
  writeFiles(occupied, { "keep.txt": "mine\n" });
  const api = await server.rpc();

  const task = await api.tasks.create({
    projectId: project.id,
    title: "Taken",
    workspace: { type: "new-branch" },
  });

  expect(task.branch).toBe("taken");
  expect(task.workspacePath).toBe(`${occupied}-2`);
  expect(existsSync(join(occupied, "keep.txt"))).toBe(true);
});

test("an invalid, existing or unresolvable branch or base fails with GIT_FAILED and leaves nothing behind", async () => {
  const { project, repo } = await addProject(server);
  const api = await server.rpc();
  const before = { branches: branches(repo), worktrees: worktreePaths(repo) };

  const attempts = [
    { type: "new-branch", branch: "bad..name" },
    { type: "new-branch", branch: "-leading-dash" },
    { type: "new-branch", branch: "main" },
    { type: "new-branch", baseBranch: "no-such-base" },
    { type: "existing-branch", branch: "no-such-branch" },
  ] as const;
  for (const workspace of attempts) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one case at a time keeps failures readable
    await expect(
      api.tasks.create({ projectId: project.id, title: "Doomed", workspace }),
    ).rejects.toMatchObject({ code: "GIT_FAILED", data: { message: expect.any(String) } });
  }

  expect({ branches: branches(repo), worktrees: worktreePaths(repo) }).toEqual(before);
  expect((await api.tasks.watch().then((updates) => updates.next())).value).toEqual([]);
});

test("create for an unknown project fails with PROJECT_NOT_FOUND", async () => {
  const api = await server.rpc();

  await expect(
    api.tasks.create({ projectId: "nope", title: "x", workspace: { type: "main-worktree" } }),
  ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND", data: { id: "nope" } });
});

test("existing-branch checks a local branch out in a new worktree", async () => {
  const { project, repo } = await addProject(server);
  runGit(repo, "branch", "feature/login");
  const api = await server.rpc();

  const task = await api.tasks.create({
    projectId: project.id,
    title: "Continue login",
    workspace: { type: "existing-branch", branch: "feature/login" },
  });

  expect(task).toMatchObject({ branch: "feature/login", ownsWorktree: true });
  expect(runGit(task.workspacePath, "branch", "--show-current").trim()).toBe("feature/login");
});

test("existing-branch on a remote-tracking branch creates a local branch tracking it", async () => {
  const { clone } = cloneOfOrigin(server.scratchDir);
  const api = await server.rpc();
  const project = await api.projects.add({ path: clone });

  const task = await api.tasks.create({
    projectId: project.id,
    title: "Release work",
    workspace: { type: "existing-branch", branch: "origin/release/1.0" },
  });

  expect(task.branch).toBe("release/1.0");
  expect(runGit(task.workspacePath, "rev-parse", "--abbrev-ref", "@{upstream}").trim()).toBe(
    "origin/release/1.0",
  );
});

test("existing-branch on a remote-tracking branch whose local branch exists uses that local branch", async () => {
  const { clone } = cloneOfOrigin(server.scratchDir);
  runGit(clone, "branch", "release/1.0", "--no-track", "origin/trunk");
  const api = await server.rpc();
  const project = await api.projects.add({ path: clone });

  const task = await api.tasks.create({
    projectId: project.id,
    title: "Release work",
    workspace: { type: "existing-branch", branch: "origin/release/1.0" },
  });

  expect(task.branch).toBe("release/1.0");
  expect(runGit(task.workspacePath, "branch", "--show-current").trim()).toBe("release/1.0");
});

test("a branch checked out in another worktree, or in the main working tree, fails with git's message", async () => {
  const { project, repo } = await addProject(server);
  runGit(repo, "branch", "busy");
  const api = await server.rpc();
  await api.tasks.create({
    projectId: project.id,
    title: "First",
    workspace: { type: "existing-branch", branch: "busy" },
  });

  const again = api.tasks.create({
    projectId: project.id,
    title: "Second",
    workspace: { type: "existing-branch", branch: "busy" },
  });
  const checkedOutHere = api.tasks.create({
    projectId: project.id,
    title: "Third",
    workspace: { type: "existing-branch", branch: "main" },
  });

  await expect(again).rejects.toMatchObject({
    code: "GIT_FAILED",
    data: { message: expect.stringContaining("busy") },
  });
  await expect(checkedOutHere).rejects.toMatchObject({ code: "GIT_FAILED" });
  expect(worktreePaths(repo)).toHaveLength(2);
});

test("a main-worktree task works in the repository itself and owns no worktree", async () => {
  const { project, repo } = await addProject(server);
  runGit(repo, "switch", "-c", "wip");
  const api = await server.rpc();

  const task = await api.tasks.create({
    projectId: project.id,
    title: "Quick look",
    workspace: { type: "main-worktree" },
  });

  expect(task).toMatchObject({ branch: "wip", workspacePath: repo, ownsWorktree: false });
  expect(worktreePaths(repo)).toEqual([repo]);
});

test("removing a main-worktree task leaves the repository and its uncommitted changes alone", async () => {
  const { project, repo } = await addProject(server);
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Quick look",
    workspace: { type: "main-worktree" },
  });
  writeFiles(repo, { "wip.txt": "unsaved\n" });

  await api.tasks.remove({ id: task.id });

  expect(existsSync(join(repo, "wip.txt"))).toBe(true);
  expect(await api.tasks.watch().then((updates) => updates.next())).toMatchObject({ value: [] });
});

test("setState settles and reactivates a task; an unknown task fails with TASK_NOT_FOUND", async () => {
  const { project } = await addProject(server);
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    title: "x",
    workspace: { type: "main-worktree" },
  });

  expect((await api.tasks.setState({ id: task.id, state: "settled" })).state).toBe("settled");
  expect((await api.tasks.watch().then((updates) => updates.next())).value).toEqual([
    { ...task, state: "settled" },
  ]);
  expect((await api.tasks.setState({ id: task.id, state: "active" })).state).toBe("active");
  await expect(api.tasks.setState({ id: "nope", state: "settled" })).rejects.toMatchObject({
    code: "TASK_NOT_FOUND",
    data: { id: "nope" },
  });
});

test("renaming a task changes its trimmed title and its source, and leaves branch, worktree and sessions alone", async () => {
  vi.stubEnv("SHELL", "/bin/sh");
  const { project } = await addProject(server);
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Fix the login bug",
    workspace: { type: "new-branch" },
  });
  const session = await api.sessions.start({
    taskId: task.id,
    kind: "shell",
    size: { cols: 80, rows: 24 },
  });
  // Subscribed before the rename, so only a real change notification can produce the second value.
  const updates = await api.tasks.watch();
  try {
    expect((await within(updates.next(), "the created task")).value).toEqual([task]);

    const renamed = await api.tasks.rename({ id: task.id, title: "  Login fails on Safari  " });

    expect(renamed).toEqual({
      ...task,
      title: "Login fails on Safari",
      titleSource: "user",
    });
    expect((await within(updates.next(), "the renamed task")).value).toEqual([renamed]);
    expect(renamed.workspacePath).toBe(task.workspacePath);
    expect(existsSync(renamed.workspacePath)).toBe(true);
    expect(runGit(renamed.workspacePath, "branch", "--show-current").trim()).toBe(task.branch);
    expect(await sessionsOf(api)).toEqual([session]);
  } finally {
    await updates.return?.();
  }
});

test("renaming an unknown task fails with TASK_NOT_FOUND and a blank title is refused", async () => {
  const { project } = await addProject(server);
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Keep me",
    workspace: { type: "main-worktree" },
  });

  await expect(api.tasks.rename({ id: "nope", title: "x" })).rejects.toMatchObject({
    code: "TASK_NOT_FOUND",
    data: { id: "nope" },
  });
  await expect(api.tasks.rename({ id: task.id, title: "   " })).rejects.toMatchObject({
    code: "BAD_REQUEST",
  });

  expect((await api.tasks.watch().then((updates) => updates.next())).value).toEqual([task]);
});

test("removing a clean task deletes its worktree and keeps the branch with its commits", async () => {
  const { project, repo } = await addProject(server);
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Clean",
    workspace: { type: "new-branch" },
  });
  commitFile(task.workspacePath, "work.txt", "done\n");

  await api.tasks.remove({ id: task.id });

  expect(existsSync(task.workspacePath)).toBe(false);
  expect(worktreePaths(repo)).toEqual([repo]);
  expect(branches(repo)).toContain("clean");
  expect(runGit(repo, "log", "clean", "--format=%s")).toContain("work.txt");
  expect((await api.tasks.watch().then((updates) => updates.next())).value).toEqual([]);
  await expect(api.tasks.remove({ id: task.id })).rejects.toMatchObject({
    code: "TASK_NOT_FOUND",
  });
});

test("a task created under the old layout keeps its stored path and can still be removed", async () => {
  const { project, repo } = await addProject(server);
  // A row as the previous layout wrote it: `<data dir>/worktrees/<project>-<short id>/<branch>`.
  const legacyPath = join(server.dataDir, "worktrees", `app-${project.id.slice(0, 8)}`, "legacy");
  runGit(repo, "worktree", "add", "-b", "legacy", legacyPath, "main");
  const legacy: Task = {
    id: "legacy",
    projectId: project.id,
    title: "Legacy",
    // A row from before title sources; the migration marked those as the user's.
    titleSource: "user",
    prompt: null,
    primarySessionId: null,
    branch: "legacy",
    workspacePath: legacyPath,
    ownsWorktree: true,
    state: "active",
    // A row from before seenAt; the migration leaves it NULL, as a task nobody has opened.
    seenAt: null,
    createdAt: 1,
  };
  const db = openDatabase(server.dataDir);
  try {
    new TaskStore(db).insert(legacy);
  } finally {
    db.close();
  }
  const api = await server.rpc();
  expect((await api.tasks.watch().then((updates) => updates.next())).value).toEqual([legacy]);

  await api.tasks.remove({ id: legacy.id });

  expect(existsSync(legacyPath)).toBe(false);
  expect(worktreePaths(repo)).toEqual([repo]);
  expect(branches(repo)).toContain("legacy");
});

test("removing a task with uncommitted or untracked changes is refused and lists the files; force removes it", async () => {
  const { project, repo } = await addProject(server);
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Dirty",
    workspace: { type: "new-branch" },
  });
  writeFiles(task.workspacePath, { "README.md": "edited\n", "notes.txt": "untracked\n" });

  await expect(api.tasks.remove({ id: task.id })).rejects.toMatchObject({
    code: "WORKTREE_DIRTY",
    data: { files: ["README.md", "notes.txt"] },
  });
  expect(existsSync(join(task.workspacePath, "notes.txt"))).toBe(true);
  expect((await api.tasks.watch().then((updates) => updates.next())).value).toEqual([task]);

  await api.tasks.remove({ id: task.id, force: true });

  expect(existsSync(task.workspacePath)).toBe(false);
  expect(worktreePaths(repo)).toEqual([repo]);
  expect(branches(repo)).toContain("dirty");
});

test("an untracked file alone makes a worktree dirty", async () => {
  const { project } = await addProject(server);
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Untracked",
    workspace: { type: "new-branch" },
  });
  writeFiles(task.workspacePath, { "scratch/new.txt": "x\n" });

  await expect(api.tasks.remove({ id: task.id })).rejects.toMatchObject({
    code: "WORKTREE_DIRTY",
    data: { files: ["scratch/"] },
  });
});

test("a task whose worktree was deleted by hand is removed, and git forgets the worktree", async () => {
  const { project, repo } = await addProject(server);
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Vanished",
    workspace: { type: "new-branch" },
  });
  await rm(task.workspacePath, { recursive: true });

  await api.tasks.remove({ id: task.id });

  expect(worktreePaths(repo)).toEqual([repo]);
  expect((await api.tasks.watch().then((updates) => updates.next())).value).toEqual([]);
  expect(branches(repo)).toContain("vanished");
});

test("a worktree that cannot be removed keeps its task and fails with git's message", async () => {
  const { project } = await addProject(server);
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Locked",
    workspace: { type: "new-branch" },
  });
  runGit(task.workspacePath, "worktree", "lock", ".");

  await expect(api.tasks.remove({ id: task.id, force: true })).rejects.toMatchObject({
    code: "GIT_FAILED",
    data: { message: expect.stringContaining("lock") },
  });
  expect((await api.tasks.watch().then((updates) => updates.next())).value).toEqual([task]);
});

test("a failure after the worktree exists undoes the worktree and the branch it made", async () => {
  const { project, repo } = await addProject(server);
  const hook = join(repo, ".git", "hooks", "post-checkout");
  writeFileSync(hook, "#!/bin/sh\necho hook refused >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  const api = await server.rpc();
  const before = { branches: branches(repo), worktrees: worktreePaths(repo) };

  await expect(
    api.tasks.create({ projectId: project.id, title: "Hooked", workspace: { type: "new-branch" } }),
  ).rejects.toMatchObject({
    code: "GIT_FAILED",
    data: { message: expect.stringContaining("hook refused") },
  });

  expect({ branches: branches(repo), worktrees: worktreePaths(repo) }).toEqual(before);
  expect(existsSync(join(server.dataDir, "worktrees", "app", "hooked"))).toBe(false);
  expect((await api.tasks.watch().then((updates) => updates.next())).value).toEqual([]);

  // The failed attempt did not poison the next one.
  chmodSync(hook, 0o644);
  expect(
    await api.tasks.create({
      projectId: project.id,
      title: "Hooked",
      workspace: { type: "new-branch" },
    }),
  ).toMatchObject({ branch: "hooked" });
});

test("a failure after tracking a remote branch removes the local branch it created, not the remote one", async () => {
  const { clone } = cloneOfOrigin(server.scratchDir);
  const hook = join(clone, ".git", "hooks", "post-checkout");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  const api = await server.rpc();
  const project = await api.projects.add({ path: clone });

  await expect(
    api.tasks.create({
      projectId: project.id,
      title: "Hooked",
      workspace: { type: "existing-branch", branch: "origin/release/1.0" },
    }),
  ).rejects.toMatchObject({ code: "GIT_FAILED" });

  expect(branches(clone)).toEqual(["trunk"]);
  expect(runGit(clone, "branch", "-r", "--format=%(refname:short)")).toContain(
    "origin/release/1.0",
  );
  expect(worktreePaths(clone)).toEqual([clone]);
});

test("a failure after an existing local branch was checked out keeps that branch", async () => {
  const { project, repo } = await addProject(server);
  runGit(repo, "branch", "precious");
  const hook = join(repo, ".git", "hooks", "post-checkout");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  const api = await server.rpc();

  await expect(
    api.tasks.create({
      projectId: project.id,
      title: "Hooked",
      workspace: { type: "existing-branch", branch: "precious" },
    }),
  ).rejects.toMatchObject({ code: "GIT_FAILED" });

  expect(branches(repo)).toContain("precious");
  expect(worktreePaths(repo)).toEqual([repo]);
});

test("watch yields all tasks now and after create, state change and remove", async () => {
  const { project } = await addProject(server);
  const api = await server.rpc();
  const updates = await api.tasks.watch();
  const next = async () => (await within(updates.next(), "a tasks update")).value;
  expect(await next()).toEqual([]);

  const task = await api.tasks.create({
    projectId: project.id,
    title: "Watched",
    workspace: { type: "main-worktree" },
  });
  expect(await next()).toEqual([task]);
  await api.tasks.setState({ id: task.id, state: "settled" });
  expect(await next()).toEqual([{ ...task, state: "settled" }]);
  await api.tasks.remove({ id: task.id });
  expect(await next()).toEqual([]);
  await updates.return?.();
});

test("a task created with an issue source defaults its title and keeps the snapshot across a restart", async () => {
  const { project } = await addProject(server);
  const api = await server.rpc();
  const source = {
    provider: "github" as const,
    host: "github.com",
    repository: "acme/app",
    number: 5,
    url: "https://github.com/acme/app/issues/5",
    title: "Issue wording",
    body: "Issue body",
    fetchedAt: 1_700_000_000_000,
  };

  const task = await api.tasks.create({
    projectId: project.id,
    source,
    workspace: { type: "main-worktree" },
  });
  expect(task).toMatchObject({ title: "Issue wording", source });

  await server.restart();
  const restarted = await server.rpc();
  const updates = await restarted.tasks.watch();
  expect((await within(updates.next(), "the task after a restart")).value).toEqual([task]);
  await updates.return?.();
});

test("tasks and their worktrees survive a server restart on the same data directory", async () => {
  const { project, repo } = await addProject(server);
  const created = await (
    await server.rpc()
  ).tasks.create({ projectId: project.id, title: "Lasting", workspace: { type: "new-branch" } });

  await server.restart();

  const api = await server.rpc();
  expect((await api.tasks.watch().then((updates) => updates.next())).value).toEqual([created]);
  await api.tasks.remove({ id: created.id });
  expect(worktreePaths(repo)).toEqual([repo]);
});

test("removing a project drops its tasks and leaves their worktrees and branches on disk", async () => {
  const { project, repo } = await addProject(server);
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Orphaned",
    workspace: { type: "new-branch" },
  });
  const updates = await api.tasks.watch();
  expect((await within(updates.next(), "initial tasks")).value).toEqual([task]);

  await api.projects.remove({ id: project.id });

  expect((await within(updates.next(), "tasks after project removal")).value).toEqual([]);
  expect(existsSync(task.workspacePath)).toBe(true);
  expect(branches(repo)).toContain("orphaned");
  await updates.return?.();
});

test("a prompt with an agent seeds the title and starts its primary chat by default", async () => {
  const { project } = await addProject(server);
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "Make the login retry\n  and say why it failed  ",
    agent: { kind: "pi" },
    workspace: { type: "new-branch" },
  });
  expect(task).toMatchObject({
    title: "Make the login retry",
    titleSource: "seed",
    prompt: "Make the login retry\n  and say why it failed",
    ownsWorktree: true,
  });
  const session = (await sessionsOf(api))[0]!;
  expect(session).toMatchObject({
    id: task.primarySessionId,
    taskId: task.id,
    kind: "pi",
    view: "chat",
    state: "running",
    terminalId: null,
  });
  const [launch] = await launchesOf(agents, "pi", 1);
  expect(launch!.argv.slice(0, 2)).toEqual(["--mode", "rpc"]);
  expect(launch!.cwd).toBe(task.workspacePath);
  const stream = await api.chat.watch({ sessionId: session.id });
  try {
    let delivered = false;
    for (let frame = 0; frame < 100 && !delivered; frame += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- consume the ordered stream until the prompt is delivered
      const next = await within(stream.next(), "the primary chat prompt");
      if (next.done) break;
      const message = next.value;
      const items =
        message.type === "snapshot"
          ? message.snapshot.items
          : message.type === "event" && message.event.type === "item"
            ? [message.event.item]
            : [];
      delivered = items.some((item) => item.kind === "user-message" && item.text === task.prompt);
    }
    expect(delivered).toBe(true);
  } finally {
    await stream.return?.();
  }
});

test("a prompt without an agent makes an empty task: the prompt is kept, nothing starts", async () => {
  const { project } = await addProject(server);
  const api = await server.rpc();

  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "Only a prompt",
    workspace: { type: "main-worktree" },
  });

  expect(task).toMatchObject({
    title: "Only a prompt",
    titleSource: "seed",
    prompt: "Only a prompt",
    primarySessionId: null,
  });
  expect(await sessionsOf(api)).toEqual([]);
  expect(await api.terminals.list()).toEqual([]);
});

test("an explicit or issue title wins over the prompt's seed, and a blank prompt is no prompt", async () => {
  const { project } = await addProject(server);
  const api = await server.rpc();

  const named = await api.tasks.create({
    projectId: project.id,
    title: "My own name",
    prompt: "Something the agent should do",
    workspace: { type: "main-worktree" },
  });
  const fromIssue = await api.tasks.create({
    projectId: project.id,
    source: {
      provider: "github",
      host: "github.com",
      repository: "acme/app",
      number: 9,
      url: "https://github.com/acme/app/issues/9",
      title: "Issue wording",
      body: "",
      fetchedAt: 1,
    },
    prompt: "Something the agent should do",
    workspace: { type: "main-worktree" },
  });
  const blank = await api.tasks.create({
    projectId: project.id,
    title: "Named only",
    prompt: "   ",
    workspace: { type: "main-worktree" },
  });

  expect(named).toMatchObject({ title: "My own name", titleSource: "user" });
  expect(fromIssue).toMatchObject({ title: "Issue wording", titleSource: "user" });
  expect(blank).toMatchObject({ title: "Named only", prompt: null });
});

test("a task with neither a title, an issue nor a prompt is refused", async () => {
  const { project } = await addProject(server);
  const api = await server.rpc();

  await expect(
    api.tasks.create({ projectId: project.id, workspace: { type: "main-worktree" } }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  await expect(
    api.tasks.create({
      projectId: project.id,
      prompt: "   ",
      workspace: { type: "main-worktree" },
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect((await api.tasks.watch().then((updates) => updates.next())).value).toEqual([]);
});

test("a primary session that cannot launch keeps the task and stays stopped with the error, and a restart starts it with the prompt", async () => {
  const { project } = await addProject(server);
  const api = await server.rpc();

  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "Fix the flaky test",
    // A profile the config file does not have: the launch is refused before anything is spawned.
    agent: { kind: "claude", profileId: "gone", view: "terminal" },
    workspace: { type: "new-branch" },
  });

  expect(task).toMatchObject({
    title: "Fix the flaky test",
    titleSource: "seed",
    workspacePath: expect.any(String),
  });
  expect(existsSync(task.workspacePath)).toBe(true);
  const failed = (await sessionsOf(api))[0]!;
  expect(failed).toMatchObject({
    id: task.primarySessionId,
    taskId: task.id,
    kind: "claude",
    state: "stopped",
    terminalId: null,
  });
  expect(failed.launchError).toBe("no usable launch profile: gone");

  // The same session starts again: no conversation was ever written, so it carries the prompt.
  const restarted = await api.sessions.restart({ id: failed.id, size: SIZE });

  expect(restarted).toMatchObject({ id: failed.id, state: "running", launchError: null });
  const [launch] = await launchesOf(agents, "claude", 1);
  expect(launch!.argv).toEqual(["--session-id", restarted.agentSessionId, " Fix the flaky test"]);
});

test("restarting the primary session of a task resumes a conversation without repeating the prompt", async () => {
  vi.stubEnv("FAKE_CLAUDE_TRANSCRIPT", "eager");
  const { project } = await addProject(server);
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "Write the migration",
    agent: { kind: "claude", view: "terminal" },
    workspace: { type: "main-worktree" },
  });
  await launchesOf(agents, "claude", 1);

  const id = task.primarySessionId!;
  const conversation = (await sessionsOf(api)).find((session) => session.id === id)!.agentSessionId;

  await api.sessions.stop({ id });
  await api.sessions.restart({ id, size: SIZE });

  expect((await launchesOf(agents, "claude", 2))[1]!.argv).toEqual(["--resume", conversation]);
});

test("removing the primary session clears the task's reference and says so on the tasks feed", async () => {
  const { project } = await addProject(server);
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "Clean up the fixtures",
    agent: { kind: "claude" },
    workspace: { type: "main-worktree" },
  });
  expect(task.primarySessionId).not.toBeNull();
  // Subscribed before the removal: only a real notification can produce the second value.
  const updates = await api.tasks.watch();
  try {
    expect((await within(updates.next(), "the created task")).value).toEqual([task]);

    await api.sessions.remove({ id: task.primarySessionId! });

    expect((await within(updates.next(), "the task without its primary session")).value).toEqual([
      { ...task, primarySessionId: null },
    ]);
  } finally {
    await updates.return?.();
  }
});

test("a restored primary session whose agent never wrote a conversation starts one with the task's prompt", async () => {
  // The default fake claude writes no transcript until it is typed at, like a start that got as
  // far as the process but never into the conversation.
  const { project } = await addProject(server);
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "Resume the primary work",
    agent: { kind: "claude", view: "terminal" },
    workspace: { type: "new-branch" },
  });
  const conversation = (await sessionsOf(api))[0]!.agentSessionId;
  expect((await launchesOf(agents, "claude", 1))[0]!.argv).toEqual([
    "--session-id",
    conversation,
    " Resume the primary work",
  ]);

  // The server comes back and restores the session: nothing resumed, so the launch is a start and
  // carries the prompt again instead of leaving the agent waiting for work it never received.
  await server.restart();

  const restored = await sessionsOf(await server.rpc());
  expect(restored).toEqual([
    expect.objectContaining({ id: task.primarySessionId, state: "running" }),
  ]);
  expect((await launchesOf(agents, "claude", 2))[1]!.argv).toEqual([
    "--session-id",
    conversation,
    " Resume the primary work",
  ]);
  expect((await launchesOf(agents, "claude", 2))[1]!.cwd).toBe(task.workspacePath);
});
