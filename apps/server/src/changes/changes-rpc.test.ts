import { z } from "zod";
import { TaskChanges, type Task } from "@corral/protocol/rpc";
import { workspaceMissingMessage } from "@corral/protocol/workspace";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { MAX_CHANGED_FILES, MAX_DIFF_CHARACTERS } from "../git/diff.ts";
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
async function worktreeTask(
  api: Api,
): Promise<{ task: Task; repo: string; base: string; projectId: string }> {
  const { project, repo } = await addProject(server);
  const base = runGit(repo, "rev-parse", "main").trim();
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Show the changes",
    workspace: { type: "new-branch" },
  });
  commitFile(task.workspacePath, "src/committed.ts", "one\ntwo\n");
  writeFiles(task.workspacePath, { "README.md": "hello\nthere\n", "notes/new.txt": "a\nb\n" });
  return { task, repo, base, projectId: project.id };
}

/** The index file of the working tree at `workspace` (a linked worktree has its own). */
function indexPath(workspace: string): string {
  return runGit(workspace, "rev-parse", "--path-format=absolute", "--git-path", "index").trim();
}

/** The index file hash: what a read must not rewrite (git refreshes it on status/diff). */
function indexHash(workspace: string): string {
  return createHash("sha256")
    .update(readFileSync(indexPath(workspace)))
    .digest("hex");
}

/**
 * Makes `name` report the same size and mtime as the index records, with different content: git
 * cannot trust its cached stat data, re-reads the file, and a refresh that is allowed to write
 * rewrites the index. That is the exact case `GIT_OPTIONAL_LOCKS=0` has to prevent.
 */
function makeRacilyClean(workspace: string, name: string, content: string): void {
  const file = join(workspace, name);
  writeFileSync(file, content);
  const when = statSync(indexPath(workspace)).mtime;
  utimesSync(file, when, when);
}

test("a worktree task diffs against the merge base with its base branch, untracked files included", async () => {
  const api = await server.rpc();
  const { task, base } = await worktreeTask(api);

  const snapshot = await api.changes.files({ id: task.id });

  expect(snapshot.base).toEqual({ commit: base, label: "main", fallback: null });
  // The base is the merge base, not the task branch's own HEAD: HEAD holds the commit below.
  expect(snapshot.base.commit).not.toBe(runGit(task.workspacePath, "rev-parse", "HEAD").trim());
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
  const { task, base } = await worktreeTask(api);
  expect((await api.changes.files({ id: task.id })).base.commit).toBe(base);

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

test("a rename is one row with both paths, its edit counts and a diff that names the rename", async () => {
  const api = await server.rpc();
  const { task, base } = await worktreeTask(api);
  // The rename carries the uncommitted edit from `worktreeTask`, so its counts are not zero.
  runGit(task.workspacePath, "mv", "README.md", "renamed.md");

  const snapshot = await api.changes.files({ id: task.id });
  expect(snapshot.base.commit).toBe(base);
  const renamed = snapshot.files.find((file) => file.status === "R");
  expect(renamed).toMatchObject({
    path: "renamed.md",
    oldPath: "README.md",
    binary: false,
    partial: false,
  });
  // numstat's counts survive the rename instead of reading as a pure move.
  expect(renamed?.additions).toBe(1);
  const diff = await api.changes.diff({ taskId: task.id, path: "renamed.md" });
  expect(diff.text).toContain("rename from README.md");
  expect(diff.text).toContain("rename to renamed.md");
});

test("a binary file is one row with a size and no diff text", async () => {
  const api = await server.rpc();
  const { task, base } = await worktreeTask(api);
  expect((await api.changes.files({ id: task.id })).base.commit).toBe(base);
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
  expect(diff).toEqual({
    path: "blob.bin",
    text: null,
    binary: true,
    size: 4,
    truncated: false,
    note: null,
  });
});

test("an untracked binary file is binary without being staged", async () => {
  const api = await server.rpc();
  const { task, base } = await worktreeTask(api);
  expect((await api.changes.files({ id: task.id })).base.commit).toBe(base);
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

test("a task whose workspace is gone stays in the list with the named sentence, not git's raw line", async () => {
  const api = await server.rpc();
  const { task, repo } = await worktreeTask(api);
  // Removing the directory behind Corral's back is what a user cleaning up by hand does.
  runGit(repo, "worktree", "remove", "--force", task.workspacePath);

  // The watch first: its list is computed from an empty cache, so this exercises the snapshot
  // preflight rather than a snapshot `files` already computed. `files` then recomputes.
  const watch = await api.changes.watch();
  const first = z.array(TaskChanges).parse((await within(watch.next(), "the changes list")).value);
  await watch.return?.();
  expect(first.find((each) => each.taskId === task.id)?.error).toBe(
    workspaceMissingMessage(task.workspacePath),
  );

  const snapshot = await api.changes.files({ id: task.id });

  expect(snapshot.files).toEqual([]);
  expect(snapshot.error).toBe(workspaceMissingMessage(task.workspacePath));
  expect(snapshot.error).not.toContain("no such directory");
});

test("reading a task's changes writes nothing to the index", async () => {
  const api = await server.rpc();
  const { task, repo, projectId } = await worktreeTask(api);
  // A file git cannot trust from the index's stat cache is what makes `git status`/`git diff`
  // refresh and rewrite `.git/index`; with `GIT_OPTIONAL_LOCKS=0` the hash stays.
  makeRacilyClean(task.workspacePath, "README.md", "HELLO\n");
  const worktreeBefore = indexHash(task.workspacePath);
  const snapshot = await api.changes.files({ id: task.id });
  await api.changes.diff({ taskId: task.id, path: "README.md" });
  expect(snapshot.files.map((file) => file.path)).toContain("README.md");
  expect(indexHash(task.workspacePath)).toBe(worktreeBefore);

  // The main working tree's own index, which the same read model touches with `HEAD` as the base.
  const mainTask = await api.tasks.create({
    projectId,
    title: "In the main tree",
    workspace: { type: "main-worktree" },
  });
  makeRacilyClean(repo, "README.md", "HELLO\n");
  const mainBefore = indexHash(repo);
  await api.changes.files({ id: mainTask.id });
  await api.changes.diff({ taskId: mainTask.id, path: "README.md" });
  expect(indexHash(repo)).toBe(mainBefore);
});

test("a huge untracked file is counted from a bounded prefix and says so", async () => {
  const api = await server.rpc();
  const { task } = await worktreeTask(api);
  // 4.8 million one-character lines: larger than the 8 MiB read, so the totals cannot be final.
  const lines = 4_800_000;
  writeFileSync(join(task.workspacePath, "big.txt"), "x\n".repeat(lines));

  const snapshot = await api.changes.files({ id: task.id });

  const big = snapshot.files.find((file) => file.path === "big.txt");
  expect(big?.status).toBe("A");
  expect(big?.partial).toBe(true);
  expect(big?.additions).toBeGreaterThan(0);
  expect(big?.additions).toBeLessThan(lines);
  expect(snapshot.additions).toBeLessThan(lines);

  const diff = await api.changes.diff({ taskId: task.id, path: "big.txt" });
  expect(diff.truncated).toBe(true);
  expect((diff.text ?? "").length).toBeLessThanOrEqual(MAX_DIFF_CHARACTERS);
});

test("the file list is capped before untracked content is read, and says it was capped", async () => {
  const api = await server.rpc();
  const { task } = await worktreeTask(api);
  const many = Object.fromEntries(
    Array.from({ length: 501 }, (_, index) => [
      `many/f${String(index).padStart(4, "0")}.txt`,
      "x\n",
    ]),
  );
  writeFiles(task.workspacePath, many);

  const snapshot = await api.changes.files({ id: task.id });

  expect(snapshot.truncated).toBe(true);
  expect(snapshot.files).toHaveLength(MAX_CHANGED_FILES);
  // The list is the sorted prefix of every changed path, not whichever 500 git listed first.
  expect(snapshot.files[0]?.path).toBe("README.md");
  expect(snapshot.files.at(-1)?.path).toMatch(/^many\//);
});

test("an unreadable untracked file stays in the list with its reason", async () => {
  const api = await server.rpc();
  const { task } = await worktreeTask(api);
  const locked = join(task.workspacePath, "locked.txt");
  writeFileSync(locked, "secret\n");
  chmodSync(locked, 0o000);
  try {
    const snapshot = await api.changes.files({ id: task.id });
    const entry = snapshot.files.find((file) => file.path === "locked.txt");
    expect(entry).toMatchObject({ status: "A", additions: 0, partial: true });
    expect(entry?.note).toContain("permission denied");

    const diff = await api.changes.diff({ taskId: task.id, path: "locked.txt" });
    expect(diff.text).toBeNull();
    expect(diff.binary).toBe(false);
    expect(diff.note).toContain("permission denied");
  } finally {
    chmodSync(locked, 0o644);
  }
});

test("an untracked symlink is its target path, not what it points at", async () => {
  const api = await server.rpc();
  const { task } = await worktreeTask(api);
  const outside = join(server.scratchDir, "secret.txt");
  writeFileSync(outside, "TOP SECRET\n");
  symlinkSync(outside, join(task.workspacePath, "leak.txt"));
  symlinkSync("/nonexistent/target", join(task.workspacePath, "dangling"));
  symlinkSync(server.scratchDir, join(task.workspacePath, "dirlink"));

  const snapshot = await api.changes.files({ id: task.id });

  for (const path of ["leak.txt", "dangling", "dirlink"]) {
    const entry = snapshot.files.find((file) => file.path === path);
    expect(entry).toMatchObject({ status: "A", additions: 1, binary: false, partial: false });
  }
  const diff = await api.changes.diff({ taskId: task.id, path: "leak.txt" });
  expect(diff.text).toContain("new file mode 120000");
  expect(diff.text).toContain(`+${outside}`);
  expect(diff.text).not.toContain("TOP SECRET");
});

test("the base is the merge base, so a commit on main after the task started is not a task change", async () => {
  const api = await server.rpc();
  const { project, repo } = await addProject(server);
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Compare",
    workspace: { type: "new-branch" },
  });
  const fork = runGit(repo, "rev-parse", "main").trim();
  commitFile(task.workspacePath, "task.txt", "task\n");
  // `main` moves ahead after the task forked: its commit is not part of what the task changed.
  commitFile(repo, "main.txt", "main\n");

  const snapshot = await api.changes.files({ id: task.id });

  expect(snapshot.base.commit).toBe(fork);
  expect(snapshot.base.commit).not.toBe(runGit(task.workspacePath, "rev-parse", "HEAD").trim());
  expect(snapshot.files.map((file) => file.path)).toContain("task.txt");
  expect(snapshot.files.map((file) => file.path)).not.toContain("main.txt");
});

test("a base branch with unrelated history is a missing merge base, not a missing branch", async () => {
  const api = await server.rpc();
  const { task, repo } = await worktreeTask(api);
  runGit(repo, "switch", "-c", "elsewhere");
  runGit(repo, "branch", "-D", "main");
  runGit(repo, "checkout", "--orphan", "main");
  commitFile(repo, "unrelated.txt", "unrelated\n");

  const snapshot = await api.changes.files({ id: task.id });

  expect(snapshot.base.label).toBe("HEAD");
  expect(snapshot.base.commit).toBe(runGit(task.workspacePath, "rev-parse", "HEAD").trim());
  expect(snapshot.base.fallback).toContain("has no merge base with HEAD");
});

test("a deleted binary file still reports its base size", async () => {
  const api = await server.rpc();
  const { project, repo } = await addProject(server);
  // The file exists in the base, so deleting it in the task is a deletion the diff can show.
  writeFileSync(join(repo, "gone.bin"), Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04]));
  runGit(repo, "add", "gone.bin");
  runGit(repo, "commit", "-m", "add a binary");
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Delete a binary",
    workspace: { type: "new-branch" },
  });
  rmSync(join(task.workspacePath, "gone.bin"));

  const snapshot = await api.changes.files({ id: task.id });
  expect(snapshot.files.find((file) => file.path === "gone.bin")).toMatchObject({
    status: "D",
    binary: true,
  });
  const diff = await api.changes.diff({ taskId: task.id, path: "gone.bin" });
  expect(diff).toMatchObject({ binary: true, text: null, size: 5 });
});

test("a file named like a glob is diffed as that file, not as every match", async () => {
  const api = await server.rpc();
  const { project, repo } = await addProject(server);
  // The literal name is in the base, so the diff is a modification and not an addition.
  writeFiles(repo, { "*.txt": "one\n" });
  runGit(repo, "--literal-pathspecs", "add", "--", "*.txt");
  runGit(repo, "commit", "-m", "a file called glob");
  const task = await api.tasks.create({
    projectId: project.id,
    title: "A glob name",
    workspace: { type: "new-branch" },
  });
  writeFiles(task.workspacePath, { "*.txt": "one\ntwo\n" });

  const snapshot = await api.changes.files({ id: task.id });
  expect(snapshot.files.map((file) => file.path)).toContain("*.txt");
  const diff = await api.changes.diff({ taskId: task.id, path: "*.txt" });
  expect(diff.text).toContain("+two");
  expect(diff.text).toContain("b/*.txt");
  // A literal pathspec returns the tracked file's patch; a glob would fall through to a new patch.
  expect(diff.text).not.toContain("new file mode");
});

test("a sparse file larger than 2 GiB is listed instead of throwing the row away", async () => {
  const api = await server.rpc();
  const { task } = await worktreeTask(api);
  const size = 2 * 1024 ** 3 + 1;
  const sparse = join(task.workspacePath, "sparse.bin");
  writeFileSync(sparse, "");
  truncateSync(sparse, size);

  const snapshot = await api.changes.files({ id: task.id });
  expect(snapshot.files.find((file) => file.path === "sparse.bin")).toMatchObject({
    status: "A",
    binary: true,
  });

  const diff = await api.changes.diff({ taskId: task.id, path: "sparse.bin" });
  expect(diff).toMatchObject({ binary: true, text: null, size });
});

test("a configured textconv driver is never run by a read", async () => {
  const api = await server.rpc();
  const { project, repo } = await addProject(server);
  // The base has the attributes file, so the driver applies to the diff of `hooked.txt`.
  writeFiles(repo, { ".gitattributes": "*.txt diff=hang\n", "hooked.txt": "one\n" });
  runGit(repo, "add", "--", ".gitattributes", "hooked.txt");
  runGit(repo, "commit", "-m", "textconv setup");
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Textconv",
    workspace: { type: "new-branch" },
  });
  const marker = join(server.scratchDir, "textconv-ran");
  runGit(
    task.workspacePath,
    "config",
    "diff.hang.textconv",
    `sh -c 'touch "${marker}"; sleep 1; cat'`,
  );
  writeFiles(task.workspacePath, { "hooked.txt": "one\ntwo\n" });

  const snapshot = await api.changes.files({ id: task.id });
  const diff = await api.changes.diff({ taskId: task.id, path: "hooked.txt" });

  expect(diff.text).toContain("+two");
  expect(snapshot.files.map((file) => file.path)).toContain("hooked.txt");
  expect(existsSync(marker)).toBe(false);
});
