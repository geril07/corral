import { z } from "zod";
import { TaskChanges, type Task } from "@corral/protocol/rpc";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { commitFile, runGit, writeFiles } from "../../test/git-repo.ts";
import { addProject } from "../../test/project-fixture.ts";
import { useServer, within } from "../../test/server-fixture.ts";

const server = useServer({
  chat: { dialogTimeoutMs: 600, readyTimeoutMs: 1200, exitGraceMs: 400, writerWaitMs: 2000 },
});
useFakeAgents();

type Api = Awaited<ReturnType<typeof server.rpc>>;

/** The task ids of one `changes.watch` yield; the RPC client types an event iterator's value as `{}`. */
function taskIdsOf(value: unknown): string[] {
  const parsed = z.array(TaskChanges).safeParse(value);
  return parsed.success ? parsed.data.map((each) => each.taskId) : [];
}

/** A task in a new worktree off `main`, with one commit, one uncommitted edit and one untracked file. */
async function worktreeTask(api: Api): Promise<{ task: Task; repo: string }> {
  const { project, repo } = await addProject(server);
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Show the changes",
    workspace: { type: "new-branch" },
  });
  commitFile(task.workspacePath, "src/committed.ts", "one\ntwo\n");
  writeFiles(task.workspacePath, { "README.md": "hello\nthere\n", "notes/new.txt": "a\nb\n" });
  return { task, repo };
}

test("a worktree task diffs against the merge base with its base branch, untracked files included", async () => {
  const api = await server.rpc();
  const { task, repo } = await worktreeTask(api);

  const snapshot = await api.changes.files({ id: task.id });

  expect(snapshot.base).toEqual({
    commit: runGit(repo, "rev-parse", "main").trim(),
    label: "main",
    fallback: null,
  });
  expect(
    snapshot.files.map((file) => [file.status, file.path, file.additions, file.deletions]),
  ).toEqual([
    ["M", "README.md", 1, 0],
    ["A", "notes/new.txt", 2, 0],
    ["A", "src/committed.ts", 2, 0],
  ]);
  // The committed file is in the list although `git status` sees nothing about it.
  expect(snapshot.additions).toBe(5);
  expect(snapshot.deletions).toBe(0);
  expect(snapshot.truncated).toBe(false);
  expect(snapshot.error).toBeNull();
});

test("changes.diff returns the committed patch and a synthesized one for an untracked file", async () => {
  const api = await server.rpc();
  const { task } = await worktreeTask(api);

  const committed = await api.changes.diff({ taskId: task.id, path: "src/committed.ts" });
  expect(committed.binary).toBe(false);
  expect(committed.truncated).toBe(false);
  expect(committed.text).toContain("+++ b/src/committed.ts");
  expect(committed.text).toContain("+one");

  const untracked = await api.changes.diff({ taskId: task.id, path: "notes/new.txt" });
  expect(untracked.text).toContain("new file mode 100644");
  expect(untracked.text).toContain("@@ -0,0 +1,2 @@");
  expect(untracked.size).toBe(Buffer.byteLength("a\nb\n"));

  await expect(api.changes.diff({ taskId: task.id, path: "not-changed.ts" })).rejects.toMatchObject(
    { code: "CHANGES_FILE_UNKNOWN" },
  );
});

test("a task in the main working tree compares HEAD with its uncommitted and untracked files", async () => {
  const api = await server.rpc();
  const { project, repo } = await addProject(server);
  const task = await api.tasks.create({
    projectId: project.id,
    title: "In the main tree",
    workspace: { type: "main-worktree" },
  });
  writeFiles(repo, { "README.md": "hello\nagain\n", "fresh.txt": "x\n" });

  const snapshot = await api.changes.files({ id: task.id });

  // The main tree has no merge base to compute: HEAD is the base, and that is not a fallback.
  expect(snapshot.base).toEqual({
    commit: runGit(repo, "rev-parse", "HEAD").trim(),
    label: "HEAD",
    fallback: null,
  });
  expect(snapshot.files.map((file) => [file.status, file.path, file.additions])).toEqual([
    ["M", "README.md", 1],
    ["A", "fresh.txt", 1],
  ]);
  const diff = await api.changes.diff({ taskId: task.id, path: "README.md" });
  expect(diff.text).toContain("+again");
});

test("a rename is one row with both paths and a diff that names the rename", async () => {
  const api = await server.rpc();
  const { task } = await worktreeTask(api);
  runGit(task.workspacePath, "mv", "README.md", "renamed.md");

  const snapshot = await api.changes.files({ id: task.id });
  expect(snapshot.files.find((file) => file.status === "R")).toMatchObject({
    path: "renamed.md",
    oldPath: "README.md",
    binary: false,
  });
  const diff = await api.changes.diff({ taskId: task.id, path: "renamed.md" });
  expect(diff.text).toContain("rename from README.md");
  expect(diff.text).toContain("rename to renamed.md");
});

test("a binary file is one row with a size and no diff text", async () => {
  const api = await server.rpc();
  const { task } = await worktreeTask(api);
  writeFileSync(join(task.workspacePath, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x0a]));
  runGit(task.workspacePath, "add", "blob.bin");

  const snapshot = await api.changes.files({ id: task.id });
  expect(snapshot.files.find((file) => file.path === "blob.bin")).toMatchObject({
    status: "A",
    binary: true,
    additions: 0,
    deletions: 0,
  });

  const diff = await api.changes.diff({ taskId: task.id, path: "blob.bin" });
  expect(diff).toEqual({ path: "blob.bin", text: null, binary: true, size: 4, truncated: false });
});

test("an untracked binary file is binary without being staged", async () => {
  const api = await server.rpc();
  const { task } = await worktreeTask(api);
  writeFiles(task.workspacePath, { "untracked.bin": "\u0000binary" });

  const snapshot = await api.changes.files({ id: task.id });
  expect(snapshot.files.find((file) => file.path === "untracked.bin")).toMatchObject({
    status: "A",
    binary: true,
  });
  // Read-only: listing changes wrote nothing to the index.
  expect(runGit(task.workspacePath, "status", "--porcelain").split("\n")).toContain(
    "?? untracked.bin",
  );
});

test("a clean worktree task has no files and zero counts", async () => {
  const api = await server.rpc();
  const { project } = await addProject(server);
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Nothing yet",
    workspace: { type: "new-branch" },
  });

  const snapshot = await api.changes.files({ id: task.id });

  expect(snapshot.files).toEqual([]);
  expect(snapshot.additions).toBe(0);
  expect(snapshot.deletions).toBe(0);
  expect(snapshot.base.fallback).toBeNull();
});

test("a deleted base branch falls back to HEAD and says so instead of failing", async () => {
  const api = await server.rpc();
  const { task, repo } = await worktreeTask(api);
  runGit(repo, "switch", "-c", "elsewhere");
  runGit(repo, "branch", "-D", "main");
  // A commit on the task branch is no longer visible under the fallback; the edit still is.
  commitFile(task.workspacePath, "after.txt", "gone with the base\n");
  writeFiles(task.workspacePath, { "local.txt": "still here\n" });

  const snapshot = await api.changes.files({ id: task.id });

  expect(snapshot.base.commit).toBe(runGit(task.workspacePath, "rev-parse", "HEAD").trim());
  expect(snapshot.base.label).toBe("HEAD");
  expect(snapshot.base.fallback).toContain("'main' is gone");
  expect(snapshot.files.map((file) => file.path)).not.toContain("after.txt");
  expect(snapshot.files.map((file) => file.path)).toContain("local.txt");
});

test("the watch lists every task, and a chat tool call makes it read again", async () => {
  const api = await server.rpc();
  const { project } = await addProject(server);
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "Add a note to notes.txt",
    agent: { kind: "pi", view: "chat" },
    workspace: { type: "main-worktree" },
  });

  const watch = await api.changes.watch();
  const first = await within(watch.next(), "the first changes list");
  expect(first.done).toBe(false);
  expect(taskIdsOf(first.value)).toEqual([task.id]);

  // The fake pi's scripted turn carries an `edit` tool call; the server recomputes the task's
  // changes because of it, so the same watch yields again without anyone asking.
  await api.chat.send({ sessionId: task.primarySessionId!, text: "go", mode: "prompt" });
  const second = await within(watch.next(), "a changes list after the tool call");
  expect(taskIdsOf(second.value)).toEqual([task.id]);
});

test("a task whose workspace is gone stays in the list with its reason", async () => {
  const api = await server.rpc();
  const { task, repo } = await worktreeTask(api);
  // Removing the directory behind Corral's back is what a user cleaning up by hand does.
  runGit(repo, "worktree", "remove", "--force", task.workspacePath);

  const snapshot = await api.changes.files({ id: task.id });

  expect(snapshot.files).toEqual([]);
  expect(snapshot.error).toContain(task.workspacePath);
});
