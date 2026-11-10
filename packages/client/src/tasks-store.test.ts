import { expect, test } from "vite-plus/test";
import { describeError, dirtyWorktreeFiles } from "./rpc-errors.ts";
import { eventually, recordStatuses, useServer } from "../test/server-fixture.ts";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runGit } from "../test/git-repo.ts";

const server = useServer();

/** The error `promise` was refused with. */
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

async function clientWithProject() {
  const client = await server.connected();
  const repo = server.repo();
  const project = await client.connection.api.projects.add({ path: repo });
  return { client, repo, project, api: client.connection.api };
}

test("the list starts unloaded, then follows create, settle and remove", async () => {
  const { client, project, api } = await clientWithProject();
  await eventually(() => expect(client.tasks.getSnapshot().loaded).toBe(true));
  expect(client.tasks.getSnapshot().tasks).toEqual([]);

  const task = await api.tasks.create({
    projectId: project.id,
    title: "Fix login",
    workspace: { type: "new-branch" },
  });
  await eventually(() => expect(client.tasks.getSnapshot().tasks).toEqual([task]));
  expect(task).toMatchObject({ state: "active", ownsWorktree: true, title: "Fix login" });
  expect(existsSync(task.workspacePath)).toBe(true);

  const settled = await api.tasks.setState({ id: task.id, state: "settled" });
  await eventually(() => expect(client.tasks.getSnapshot().tasks).toEqual([settled]));

  await api.tasks.remove({ id: task.id });
  await eventually(() => expect(client.tasks.getSnapshot().tasks).toEqual([]));
  expect(existsSync(task.workspacePath)).toBe(false);
  expect(task.branch).not.toBeNull();
  expect(runGit(project.path, "branch", "--list", task.branch!)).toContain(task.branch);
});

test("after the connection drops, the list catches up with what changed meanwhile", async () => {
  const proxy = await server.proxy();
  const client = await server.connected(proxy.url);
  const statuses = recordStatuses(client.connection.state);
  const { api } = client.connection;
  const project = await api.projects.add({ path: server.repo() });
  const create = (title: string) =>
    api.tasks.create({ projectId: project.id, title, workspace: { type: "main-worktree" } });
  const before = await create("before");
  await eventually(() => expect(client.tasks.getSnapshot().tasks).toEqual([before]));

  proxy.refuse(true);
  proxy.drop();
  await eventually(() => expect(statuses).toContain("disconnected"));

  const other = (await server.connected()).connection.api;
  const during = await other.tasks.create({
    projectId: project.id,
    title: "during",
    workspace: { type: "main-worktree" },
  });
  await other.tasks.remove({ id: before.id });
  proxy.refuse(false);

  await eventually(() => expect(client.tasks.getSnapshot().tasks).toEqual([during]));
});

test("the server's refusals read as sentences, and a dirty worktree names its files", async () => {
  const { project, api } = await clientWithProject();

  const missing = await rejection(
    api.tasks.create({
      projectId: project.id,
      title: "Ghost",
      workspace: { type: "existing-branch", branch: "no-such-branch" },
    }),
  );
  expect(describeError(missing)).toMatch(/no-such-branch/);

  const task = await api.tasks.create({
    projectId: project.id,
    title: "Dirty",
    workspace: { type: "new-branch" },
  });
  writeFileSync(join(task.workspacePath, "notes.txt"), "unsaved\n");
  const refused = await rejection(api.tasks.remove({ id: task.id }));
  expect(dirtyWorktreeFiles(refused)).toEqual(["notes.txt"]);
  expect(existsSync(task.workspacePath)).toBe(true);

  await api.tasks.remove({ id: task.id, force: true });
  expect(existsSync(task.workspacePath)).toBe(false);
});

test("seenAt lives on the server, so a restart keeps it and another client sees the same time", async () => {
  const { client, project, api } = await clientWithProject();
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Seen",
    workspace: { type: "main-worktree" },
  });
  expect(task.seenAt).toBeNull();

  const marked = await api.tasks.markSeen({ id: task.id });
  expect(marked.seenAt).toEqual(expect.any(Number));
  await eventually(() => expect(client.tasks.getSnapshot().tasks).toEqual([marked]));

  await server.restart();

  const after = await server.connected();
  await eventually(() => expect(after.tasks.getSnapshot().tasks).toEqual([marked]));
  expect(await rejection(after.connection.api.tasks.markSeen({ id: "gone" }))).toMatchObject({
    code: "TASK_NOT_FOUND",
  });
});
