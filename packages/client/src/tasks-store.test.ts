import { expect, test } from "vite-plus/test";
import { describeError, dirtyWorktreeFiles } from "./rpc-errors.ts";
import { buildWorkspaceTree, resolveSelection } from "./workspace-tree.ts";
import { eventually, recordStatuses, sh, useServer } from "../test/server-fixture.ts";
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

test("the list starts unloaded, then follows create, archive and remove", async () => {
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

  const archived = await api.tasks.setState({ id: task.id, state: "archived" });
  await eventually(() => expect(client.tasks.getSnapshot().tasks).toEqual([archived]));

  await api.tasks.remove({ id: task.id });
  await eventually(() => expect(client.tasks.getSnapshot().tasks).toEqual([]));
  expect(existsSync(task.workspacePath)).toBe(false);
  expect(runGit(project.path, "branch", "--list", task.branch)).toContain(task.branch);
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

test("a terminal started in a task shows under it in the tree, and a task removed takes it along", async () => {
  const { client, project, api } = await clientWithProject();
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Work",
    workspace: { type: "new-branch" },
  });
  const inTask = await api.terminals.create({
    taskId: task.id,
    size: { cols: 80, rows: 24 },
    ...sh("pwd; read x"),
  });
  const loose = await api.terminals.create({ size: { cols: 80, rows: 24 }, ...sh("read x") });
  expect(inTask).toMatchObject({ taskId: task.id, cwd: task.workspacePath });

  const treeOf = () =>
    buildWorkspaceTree(
      client.projects.getSnapshot().projects,
      client.tasks.getSnapshot().tasks,
      client.terminals.getSnapshot().terminals,
    );
  await eventually(() => {
    const tree = treeOf();
    expect(tree.projects[0]?.active[0]?.terminals.map((t) => t.id)).toEqual([inTask.id]);
    expect(tree.loose.map((t) => t.id)).toEqual([loose.id]);
  });
  expect(resolveSelection(treeOf(), {})).toMatchObject({
    taskId: task.id,
    terminalId: inTask.id,
  });

  await api.tasks.remove({ id: task.id });
  await eventually(() => {
    expect(client.terminals.getSnapshot().terminals.map((t) => t.id)).toEqual([loose.id]);
    expect(client.tasks.getSnapshot().tasks).toEqual([]);
  });
  expect(resolveSelection(treeOf(), { taskId: task.id })).toMatchObject({
    taskId: null,
    terminalId: loose.id,
  });
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
