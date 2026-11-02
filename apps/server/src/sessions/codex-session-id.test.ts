import type { Session } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { addTask } from "../../test/project-fixture.ts";
import { writeRollout } from "../../test/rollouts.ts";
import { useServer } from "../../test/server-fixture.ts";
import { frontendArgs, launchesOf, sessionsOf } from "../../test/session-helpers.ts";

const server = useServer();
const agents = useFakeAgents();
const SIZE = { cols: 80, rows: 24 };
const HOUR_MS = 60 * 60 * 1000;

async function startCodex(taskId: string) {
  const api = await server.rpc();
  const session = await api.sessions.start({ taskId, kind: "codex", size: SIZE });
  const client = await server.attach(session.terminalId!);
  await client.waitForScreen("fake codex ready");
  return { api, session, client };
}

async function stateOf(session: Session): Promise<Session> {
  const sessions = await sessionsOf(await server.rpc());
  return sessions.find((entry) => entry.id === session.id)!;
}

test("the id of a rollout Codex wrote at start is learned and shown on the session", async () => {
  const { task } = await addTask(server, "Eager");
  const { session } = await startCodex(task.id);
  const [launch] = await launchesOf(agents, "codex", 1);

  await expect
    .poll(async () => (await stateOf(session)).agentSessionId, { timeout: 10_000 })
    .toBe(launch!.rolloutId);
});

test("a rollout Codex only writes at the first prompt is found then, and not before", async () => {
  vi.stubEnv("FAKE_CODEX_ROLLOUT", "lazy");
  const { task } = await addTask(server, "Lazy");
  const { session, client } = await startCodex(task.id);
  const [launch] = await launchesOf(agents, "codex", 1);
  expect((await stateOf(session)).agentSessionId).toBeNull();

  client.type("hello\n");
  await client.waitForScreen("fake codex got: hello");

  await expect
    .poll(async () => (await stateOf(session)).agentSessionId, { timeout: 10_000 })
    .toBe(launch!.rolloutId);
});

test("rollouts of other workspaces, or from before the session started, are not mistaken for it", async () => {
  vi.stubEnv("FAKE_CODEX_ROLLOUT", "lazy");
  const { task } = await addTask(server, "Foreign");
  writeRollout(agents.codexHome, {
    id: "older-same-workspace",
    cwd: task.workspacePath,
    startedAt: new Date(Date.now() - HOUR_MS),
  });
  const { session, client } = await startCodex(task.id);
  writeRollout(agents.codexHome, {
    id: "newer-other-workspace",
    cwd: `${task.workspacePath}-other`,
    startedAt: new Date(Date.now() + HOUR_MS),
  });
  writeRollout(agents.codexHome, {
    id: "not-a-session-record",
    cwd: task.workspacePath,
    firstLine: '{"type":"event_msg","payload":{"cwd":"x"}}',
  });
  client.type("hello\n");
  await client.waitForScreen("fake codex got: hello");
  const [launch] = await launchesOf(agents, "codex", 1);

  await expect
    .poll(async () => (await stateOf(session)).agentSessionId, { timeout: 10_000 })
    .toBe(launch!.rolloutId);
});

test("two new rollouts in the workspace are ambiguous: no id is guessed, and the stopped session cannot be resumed", async () => {
  vi.stubEnv("FAKE_CODEX_ROLLOUT", "never");
  const { api, task } = await addTask(server, "Ambiguous");
  const { session } = await startCodex(task.id);
  writeRollout(agents.codexHome, { id: "first", cwd: task.workspacePath });
  writeRollout(agents.codexHome, { id: "second", cwd: task.workspacePath });

  const stopped = await api.sessions.stop({ id: session.id });

  expect(stopped).toMatchObject({ agentSessionId: null, state: "unresumable", terminalId: null });
});

test("a Codex session that never wrote a rollout becomes unresumable, and restarting it opens a new conversation", async () => {
  vi.stubEnv("FAKE_CODEX_ROLLOUT", "never");
  const { api, task } = await addTask(server, "Never");
  const { session } = await startCodex(task.id);

  expect(await api.sessions.stop({ id: session.id })).toMatchObject({
    agentSessionId: null,
    state: "unresumable",
  });
  const restarted = await api.sessions.restart({ id: session.id, size: SIZE });

  expect(restarted).toMatchObject({ state: "running", agentSessionId: null });
  expect((await launchesOf(agents, "codex", 2)).map((launch) => frontendArgs(launch.argv))).toEqual(
    [[], []],
  );
});

test("a Codex session that exits by itself without a rollout becomes unresumable", async () => {
  vi.stubEnv("FAKE_CODEX_ROLLOUT", "never");
  const { task } = await addTask(server, "Gave up");
  const { session, client } = await startCodex(task.id);

  client.type("exit\n");

  await expect
    .poll(() => stateOf(session), { timeout: 10_000 })
    .toMatchObject({ state: "unresumable", agentSessionId: null, terminalId: session.terminalId });
});

test("a Codex session that wrote its rollout and then exited by itself keeps its id and can be resumed", async () => {
  vi.stubEnv("FAKE_CODEX_ROLLOUT", "lazy");
  const { api, task } = await addTask(server, "Prompted and quit");
  const { session, client } = await startCodex(task.id);
  const [launch] = await launchesOf(agents, "codex", 1);
  client.type("hello\nexit\n");
  await client.waitForClose();

  await expect
    .poll(() => stateOf(session), { timeout: 10_000 })
    .toMatchObject({ state: "stopped", agentSessionId: launch!.rolloutId, launchError: null });
  await api.sessions.restart({ id: session.id, size: SIZE });

  expect(frontendArgs((await launchesOf(agents, "codex", 2))[1]!.argv)).toEqual([
    "resume",
    launch!.rolloutId,
  ]);
});

test("a stopped Codex session with an id resumes it by id, without searching for a new one", async () => {
  const { api, task } = await addTask(server, "Resume");
  const { session } = await startCodex(task.id);
  const [launch] = await launchesOf(agents, "codex", 1);
  await expect
    .poll(async () => (await stateOf(session)).agentSessionId, { timeout: 10_000 })
    .toBe(launch!.rolloutId);
  await api.sessions.stop({ id: session.id });

  const restarted = await api.sessions.restart({ id: session.id, size: SIZE });

  expect(restarted).toMatchObject({ state: "running", agentSessionId: launch!.rolloutId });
  expect(frontendArgs((await launchesOf(agents, "codex", 2))[1]!.argv)).toEqual([
    "resume",
    launch!.rolloutId,
  ]);
});
