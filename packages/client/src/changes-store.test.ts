import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { eventually, useServer } from "../test/server-fixture.ts";
import { runGit } from "../test/git-repo.ts";

const server = useServer();

test("the store follows a task's changed files, recomputes on refresh and returns a file's diff", async () => {
  const setup = await server.connected();
  const { api } = setup.connection;
  const project = await api.projects.add({ path: server.repo() });
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Changes",
    workspace: { type: "new-branch" },
  });

  // A client that connects now gets the task in its first list, a clean one included.
  const client = await server.connected();
  // The watch lists every task, a clean one included.
  await eventually(() => expect(client.changes.getSnapshot().loaded).toBe(true));
  expect(client.changes.getSnapshot().byTask.get(task.id)?.files).toEqual([]);
  expect(client.changes.getSnapshot().failed).toBe(false);

  writeFileSync(join(task.workspacePath, "notes.txt"), "one\ntwo\n");

  // The watch cannot see a write nobody told the server about; refresh is the pull that can.
  await client.changes.refresh(task.id);
  const refreshed = client.changes.getSnapshot().byTask.get(task.id);
  expect(refreshed?.files).toMatchObject([
    { path: "notes.txt", status: "A", additions: 2, deletions: 0 },
  ]);
  // The store's other entries stay as they were: a refresh merges one task, not the whole list.
  expect(client.changes.getSnapshot().byTask.size).toBe(1);

  const diff = await client.changes.diff(task.id, "notes.txt");
  expect(diff.text).toContain("+one");
  expect(diff.binary).toBe(false);

  await expect(client.changes.diff(task.id, "missing.txt")).rejects.toMatchObject({
    code: "CHANGES_FILE_UNKNOWN",
  });
});

test("the store tells a task that cannot be read apart from a clean one", async () => {
  const client = await server.connected();
  const { api } = client.connection;
  const project = await api.projects.add({ path: server.repo() });
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Gone",
    workspace: { type: "new-branch" },
  });
  runGit(project.path, "worktree", "remove", "--force", task.workspacePath);

  await client.changes.refresh(task.id);

  const snapshot = client.changes.getSnapshot().byTask.get(task.id);
  expect(snapshot?.files).toEqual([]);
  expect(snapshot?.error).toContain(task.workspacePath);
});
