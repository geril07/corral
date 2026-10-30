import type { Session } from "@corral/protocol/rpc";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { useFakeAgents, type Launch } from "../../test/fake-agents.ts";
import { writeFiles } from "../../test/git-repo.ts";
import { addTask } from "../../test/project-fixture.ts";
import {
  launchesOf as launchesOfAgent,
  processExists,
  sessionsOf,
} from "../../test/session-helpers.ts";
import { useServer, within } from "../../test/server-fixture.ts";

const server = useServer();
const agents = useFakeAgents();
const SIZE = { cols: 80, rows: 24 };
// Wide enough that a worktree path does not wrap on screen.
const WIDE = { cols: 300, rows: 24 };

function launchesOf(agent: Launch["agent"], count: number) {
  return launchesOfAgent(agents, agent, count);
}

async function launchOf(agent: Launch["agent"]): Promise<Launch> {
  const [launch] = await launchesOf(agent, 1);
  return launch!;
}

async function ready(session: Session, text: string) {
  const client = await server.attach(session.terminalId!);
  await client.waitForScreen(text);
  return client;
}

test("a shell session runs the user's shell in the task's workspace and is listed with its terminal", async () => {
  vi.stubEnv("SHELL", "/bin/sh");
  const { api, task } = await addTask(server, "Shell work");

  const session = await api.sessions.start({ taskId: task.id, kind: "shell", size: WIDE });

  expect(session).toMatchObject({
    taskId: task.id,
    kind: "shell",
    agentSessionId: null,
    state: "running",
    terminalId: expect.any(String),
  });
  expect(await api.terminals.list()).toEqual([
    {
      id: session.terminalId,
      taskId: task.id,
      sessionId: session.id,
      command: "/bin/sh",
      args: [],
      cwd: task.workspacePath,
      size: WIDE,
      exit: null,
    },
  ]);
  const client = await server.attach(session.terminalId!);
  client.type('echo "in:$PWD:$CORRAL_SESSION_ID:$CORRAL_TASK_ID"\n');
  await client.waitForScreen(`in:${task.workspacePath}:${session.id}:${task.id}`);
});

test("a session in a main-worktree task starts in the repository", async () => {
  const { api, task, repo } = await addTask(server, "Look around", "main-worktree");
  const session = await api.sessions.start({ taskId: task.id, kind: "claude", size: SIZE });

  expect((await launchOf("claude")).cwd).toBe(repo);
  expect(session.taskId).toBe(task.id);
});

const IDS_WE_CHOOSE = {
  claude: {
    format: /^[0-9a-f-]{36}$/,
    start: (id: string) => ["--session-id", id],
    resume: (id: string) => ["--resume", id],
  },
  pi: {
    format: /^[0-9a-f-]{36}$/,
    start: (id: string) => ["--session-id", id],
    resume: (id: string) => ["--session-id", id],
  },
  opencode: {
    format: /^ses_[0-9A-Za-z]{26}$/,
    start: (id: string) => ["--session", id],
    resume: (id: string) => ["--session", id],
  },
} as const;

test.each(["claude", "pi", "opencode"] as const)(
  "%s starts under an id we chose and resumes under it after a stop",
  async (kind) => {
    const { api, task } = await addTask(server, "Agents");
    const { format, start, resume } = IDS_WE_CHOOSE[kind];

    const session = await api.sessions.start({ taskId: task.id, kind, size: SIZE });
    const id = session.agentSessionId!;
    expect(id).toMatch(format);
    const client = await ready(session, `fake ${kind} ready`);
    expect(await launchesOf(kind, 1)).toMatchObject([
      {
        argv: start(id),
        cwd: task.workspacePath,
        env: { CORRAL_SESSION_ID: session.id, CORRAL_TASK_ID: task.id },
      },
    ]);

    // Claude Code has no conversation to resume before the first prompt.
    client.type("hello\n");
    await client.waitForScreen(`fake ${kind} got: hello`);
    await api.sessions.stop({ id: session.id });
    const restarted = await api.sessions.restart({ id: session.id, size: SIZE });
    expect(restarted).toMatchObject({ id: session.id, agentSessionId: id, state: "running" });
    expect((await launchesOf(kind, 2))[1]).toMatchObject({
      argv: resume(id),
      env: { CORRAL_SESSION_ID: session.id, CORRAL_TASK_ID: task.id },
    });
  },
);

test.each([
  { kind: "claude", flag: "--session-id", flagAfterPrompt: "--resume" },
  { kind: "pi", flag: "--session-id", flagAfterPrompt: "--session-id" },
  { kind: "opencode", flag: "--session", flagAfterPrompt: "--session" },
] as const)(
  "a $kind session restarted before any prompt keeps its id; the conversation is resumed once it has history",
  async ({ kind, flag, flagAfterPrompt }) => {
    const { api, task } = await addTask(server, "No prompt");
    const session = await api.sessions.start({ taskId: task.id, kind, size: SIZE });
    const id = session.agentSessionId!;
    await ready(session, `fake ${kind} ready`);

    await api.sessions.stop({ id: session.id });
    const second = await api.sessions.restart({ id: session.id, size: SIZE });
    const client = await ready(second, `fake ${kind} ready`);
    expect((await launchesOf(kind, 2))[1]!.argv).toEqual([flag, id]);
    expect(second.agentSessionId).toBe(id);

    client.type("hello\n");
    await client.waitForScreen(`fake ${kind} got: hello`);
    await api.sessions.stop({ id: session.id });
    await api.sessions.restart({ id: session.id, size: SIZE });
    expect((await launchesOf(kind, 3))[2]!.argv).toEqual([flagAfterPrompt, id]);
  },
);

test("codex starts with no arguments and no id yet", async () => {
  vi.stubEnv("FAKE_CODEX_ROLLOUT", "never");
  const { api, task } = await addTask(server, "Codex");
  const session = await api.sessions.start({ taskId: task.id, kind: "codex", size: SIZE });

  expect(session.agentSessionId).toBeNull();
  const [launch] = await launchesOf("codex", 1);
  expect(launch).toMatchObject({
    argv: [],
    env: { CORRAL_SESSION_ID: session.id, CORRAL_TASK_ID: task.id },
  });
});

test("an agent that is not on PATH fails with AGENT_NOT_FOUND and leaves nothing behind", async () => {
  const { api, task } = await addTask(server, "Missing");
  vi.stubEnv("PATH", await mkdtemp(join(tmpdir(), "corral-empty-path-")));

  await expect(
    api.sessions.start({ taskId: task.id, kind: "claude", size: SIZE }),
  ).rejects.toMatchObject({
    code: "AGENT_NOT_FOUND",
    data: { command: "claude" },
  });
  expect(await sessionsOf(api)).toEqual([]);
  expect(await api.terminals.list()).toEqual([]);
});

test("an unknown task is TASK_NOT_FOUND", async () => {
  const api = await server.rpc();
  await expect(
    api.sessions.start({ taskId: "nope", kind: "shell", size: SIZE }),
  ).rejects.toMatchObject({
    code: "TASK_NOT_FOUND",
    data: { id: "nope" },
  });
});

test("an agent that exits by itself leaves a stopped session whose exited terminal is still listed", async () => {
  const { api, task } = await addTask(server, "Quitter");
  const session = await api.sessions.start({ taskId: task.id, kind: "claude", size: SIZE });
  const client = await ready(session, "fake claude ready");

  client.type("exit 3\n");
  await client.waitForClose();

  await expect
    .poll(() => sessionsOf(api), { timeout: 10_000 })
    .toEqual([{ ...session, state: "stopped" }]);
  expect((await api.terminals.list()).map((terminal) => [terminal.id, terminal.exit])).toEqual([
    [session.terminalId, { exitCode: 3 }],
  ]);
});

test("restarting a session that exited by itself replaces its exited terminal", async () => {
  const { api, task } = await addTask(server, "Again");
  const session = await api.sessions.start({ taskId: task.id, kind: "claude", size: SIZE });
  const client = await ready(session, "fake claude ready");
  client.type("exit\n");
  await client.waitForClose();

  const restarted = await api.sessions.restart({ id: session.id, size: SIZE });

  expect(restarted.terminalId).not.toBe(session.terminalId);
  expect((await api.terminals.list()).map((terminal) => terminal.id)).toEqual([
    restarted.terminalId,
  ]);
});

test("stop kills the process, closes the terminal and leaves a stopped session without one", async () => {
  const { api, task } = await addTask(server, "Stop me");
  const session = await api.sessions.start({ taskId: task.id, kind: "pi", size: SIZE });
  await ready(session, "fake pi ready");
  const { pid } = await launchOf("pi");

  const stopped = await api.sessions.stop({ id: session.id });

  expect(stopped).toMatchObject({ id: session.id, state: "stopped", terminalId: null });
  expect(await api.terminals.list()).toEqual([]);
  await expect.poll(() => processExists(pid), { timeout: 10_000 }).toBe(false);
});

test("a running session cannot be restarted; an unknown one is SESSION_NOT_FOUND", async () => {
  const { api, task } = await addTask(server, "Busy");
  const session = await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });

  await expect(api.sessions.restart({ id: session.id, size: SIZE })).rejects.toMatchObject({
    code: "ALREADY_RUNNING",
  });
  const notFound = { code: "SESSION_NOT_FOUND", data: { id: "nope" } };
  await expect(api.sessions.restart({ id: "nope", size: SIZE })).rejects.toMatchObject(notFound);
  await expect(api.sessions.stop({ id: "nope" })).rejects.toMatchObject(notFound);
  await expect(api.sessions.remove({ id: "nope" })).rejects.toMatchObject(notFound);
});

test("a stopped shell starts again fresh in a new terminal", async () => {
  vi.stubEnv("SHELL", "/bin/sh");
  const { api, task } = await addTask(server, "Shell again");
  const session = await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });
  await api.sessions.stop({ id: session.id });

  const restarted = await api.sessions.restart({ id: session.id, size: SIZE });

  expect(restarted).toMatchObject({ id: session.id, agentSessionId: null, state: "running" });
  expect(restarted.terminalId).not.toBe(session.terminalId);
  expect((await api.terminals.list()).map((terminal) => terminal.id)).toEqual([
    restarted.terminalId,
  ]);
});

test("remove stops a running session, kills its process and forgets it", async () => {
  const { api, task } = await addTask(server, "Remove me");
  const session = await api.sessions.start({ taskId: task.id, kind: "opencode", size: SIZE });
  await ready(session, "fake opencode ready");
  const { pid } = await launchOf("opencode");
  const other = await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });

  await api.sessions.remove({ id: session.id });

  const listed = await sessionsOf(api);
  expect(listed.map((entry) => entry.id)).toEqual([other.id]);
  expect((await api.terminals.list()).map((terminal) => terminal.id)).toEqual([other.terminalId]);
  await expect.poll(() => processExists(pid), { timeout: 10_000 }).toBe(false);
});

test("closing a session's terminal stops the session; other terminals close as before", async () => {
  const { api, task } = await addTask(server, "Close");
  const session = await api.sessions.start({ taskId: task.id, kind: "claude", size: SIZE });
  await ready(session, "fake claude ready");
  const loose = await server.createTerminal();

  await api.terminals.close({ id: session.terminalId! });
  await api.terminals.close({ id: loose.id });

  const listed = await sessionsOf(api);
  expect(listed).toEqual([{ ...session, state: "stopped", terminalId: null }]);
  expect(await api.terminals.list()).toEqual([]);
  await expect(api.terminals.close({ id: loose.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
});

test("watch yields the sessions now and after every change", async () => {
  const { api, task } = await addTask(server, "Watch");
  const updates = await api.sessions.watch();
  expect((await within(updates.next(), "initial sessions")).value).toEqual([]);

  const session = await api.sessions.start({ taskId: task.id, kind: "claude", size: SIZE });
  expect((await within(updates.next(), "started")).value).toEqual([session]);

  await api.sessions.stop({ id: session.id });
  expect((await within(updates.next(), "stopped")).value).toEqual([
    { ...session, state: "stopped", terminalId: null },
  ]);

  await api.sessions.remove({ id: session.id });
  expect((await within(updates.next(), "removed")).value).toEqual([]);
  await updates.return?.();
});

test("removing a task stops its sessions and kills their processes; other tasks' sessions stay", async () => {
  const { api, task, project } = await addTask(server, "Doomed");
  const survivor = await api.tasks.create({
    projectId: project.id,
    title: "Survivor",
    workspace: { type: "new-branch" },
  });
  const doomed = await api.sessions.start({ taskId: task.id, kind: "claude", size: SIZE });
  await ready(doomed, "fake claude ready");
  await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });
  const kept = await api.sessions.start({ taskId: survivor.id, kind: "pi", size: SIZE });
  const { pid } = await launchOf("claude");

  await api.tasks.remove({ id: task.id });

  const listed = await sessionsOf(api);
  expect(listed.map((session) => session.id)).toEqual([kept.id]);
  expect((await api.terminals.list()).map((terminal) => terminal.id)).toEqual([kept.terminalId]);
  await expect.poll(() => processExists(pid), { timeout: 10_000 }).toBe(false);
});

test("a task removal refused for a dirty worktree keeps its sessions running", async () => {
  const { api, task } = await addTask(server, "Dirty");
  writeFiles(task.workspacePath, { "unsaved.txt": "x\n" });
  const session = await api.sessions.start({ taskId: task.id, kind: "claude", size: SIZE });

  await expect(api.tasks.remove({ id: task.id })).rejects.toMatchObject({ code: "WORKTREE_DIRTY" });

  const listed = await sessionsOf(api);
  expect(listed).toEqual([session]);
  expect(await api.terminals.list()).toHaveLength(1);
});

test("a project with a running session cannot be removed; once the session is stopped it can, and takes its sessions along", async () => {
  const { api, project, task } = await addTask(server, "Busy project");
  const session = await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });

  await expect(api.projects.remove({ id: project.id })).rejects.toMatchObject({
    code: "HAS_LIVE_TERMINALS",
  });
  await api.sessions.stop({ id: session.id });
  await api.projects.remove({ id: project.id });

  expect(await sessionsOf(api)).toEqual([]);
  expect(await api.terminals.list()).toEqual([]);
});
