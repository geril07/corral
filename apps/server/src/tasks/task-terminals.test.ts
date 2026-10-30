import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { writeFiles } from "../../test/git-repo.ts";
import { sh } from "../../test/programs.ts";
import { addProject } from "../../test/project-fixture.ts";
import { useServer, within } from "../../test/server-fixture.ts";

const server = useServer();

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function newTask(title: string, workspace: "new-branch" | "main-worktree" = "new-branch") {
  const { project, repo } = await addProject(server);
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    title,
    workspace: { type: workspace },
  });
  return { api, project, repo, task };
}

test("a terminal in a task starts in the task's worktree and reports the task", async () => {
  const { task } = await newTask("Shell work");

  const info = await server.createTerminal(sh("pwd; read x"), { taskId: task.id });

  expect(info).toMatchObject({ taskId: task.id, cwd: task.workspacePath });
  const client = await server.attach(info.id);
  await client.waitForScreen(task.workspacePath);
});

test("a terminal in a main-worktree task starts in the repository", async () => {
  const { task, repo } = await newTask("Look around", "main-worktree");

  const info = await server.createTerminal(sh("read x"), { taskId: task.id });

  expect(info).toMatchObject({ taskId: task.id, cwd: repo });
});

test("a terminal outside any task has no taskId", async () => {
  const info = await server.createTerminal(sh("read x"));

  expect(info.taskId).toBeNull();
});

test("taskId together with cwd is a BAD_REQUEST, and an unknown task is TASK_NOT_FOUND; no terminal appears", async () => {
  const { api, task } = await newTask("Strict");

  await expect(
    api.terminals.create({ taskId: task.id, cwd: "/tmp", size: { cols: 80, rows: 24 } }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST", data: { message: expect.any(String) } });
  await expect(
    api.terminals.create({ taskId: "nope", size: { cols: 80, rows: 24 } }),
  ).rejects.toMatchObject({ code: "TASK_NOT_FOUND", data: { id: "nope" } });
  expect(await api.terminals.list()).toEqual([]);
});

test("removing a task closes its terminals, kills their processes and leaves other terminals alone", async () => {
  const { api, task } = await newTask("Doomed");
  const pidFile = join(server.scratchDir, "pid");
  const inTask = await server.createTerminal(sh(`echo $$ > ${pidFile}; echo started; sleep 600`), {
    taskId: task.id,
  });
  await server.createTerminal(sh("exit 0"), { taskId: task.id });
  const elsewhere = await server.createTerminal(sh("read x"));
  const client = await server.attach(inTask.id);
  await client.waitForScreen("started");
  const pid = Number(await readFile(pidFile, "utf8"));

  await api.tasks.remove({ id: task.id });

  expect((await api.terminals.list()).map((terminal) => terminal.id)).toEqual([elsewhere.id]);
  await expect
    .poll(() => processExists(pid), { timeout: 10_000, message: "process exits with its task" })
    .toBe(false);
});

test("a removal refused for a dirty worktree keeps the terminals running", async () => {
  const { api, task } = await newTask("Dirty");
  writeFiles(task.workspacePath, { "unsaved.txt": "x\n" });
  const info = await server.createTerminal(sh("read x"), { taskId: task.id });

  await expect(api.tasks.remove({ id: task.id })).rejects.toMatchObject({ code: "WORKTREE_DIRTY" });

  expect(await api.terminals.list()).toEqual([info]);
});

test("a forced removal closes the terminals before the worktree goes", async () => {
  const { api, task } = await newTask("Forced");
  writeFiles(task.workspacePath, { "unsaved.txt": "x\n" });
  await server.createTerminal(sh("read x"), { taskId: task.id });
  const updates = await api.terminals.watch();
  expect((await within(updates.next(), "initial terminals")).value).toHaveLength(1);

  await api.tasks.remove({ id: task.id, force: true });

  expect((await within(updates.next(), "terminals after removal")).value).toEqual([]);
  await updates.return?.();
});

test("a project with a running terminal in one of its tasks cannot be removed; once the terminal exits it can", async () => {
  const { api, project, task } = await newTask("Busy");
  const running = await server.createTerminal(sh("read x; exit 3"), { taskId: task.id });

  await expect(api.projects.remove({ id: project.id })).rejects.toMatchObject({
    code: "HAS_LIVE_TERMINALS",
  });
  expect(await api.tasks.watch().then((updates) => updates.next())).toMatchObject({
    value: [task],
  });

  const client = await server.attach(running.id);
  client.type("\n");
  await client.waitForClose();
  await api.projects.remove({ id: project.id });

  expect(await api.terminals.list()).toEqual([]);
  expect(await api.projects.watch().then((updates) => updates.next())).toMatchObject({ value: [] });
});
