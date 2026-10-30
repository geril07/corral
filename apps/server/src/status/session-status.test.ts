import type { Session } from "@corral/protocol/rpc";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { useFakeAgents, type Launch } from "../../test/fake-agents.ts";
import { reportBody } from "../../test/osc7501.ts";
import { useServer } from "../../test/server-fixture.ts";
import { addTask } from "../../test/project-fixture.ts";
import { launchesOf, sessionsOf, watchStatus } from "../../test/session-helpers.ts";

const server = useServer();
const agents = useFakeAgents();
const SIZE = { cols: 80, rows: 24 };

/** A running fake agent in a new task, a client attached to its terminal, and a watcher on its status. */
async function startAgent(kind: Launch["agent"] | "shell") {
  const { api, task } = await addTask(server, "Status");
  const session = await api.sessions.start({ taskId: task.id, kind, size: SIZE });
  const client = await server.attach(session.terminalId!);
  const watcher = await watchStatus(api, session.id);
  const launch = async () =>
    kind === "shell" ? undefined : (await launchesOf(agents, kind, 1))[0];
  if (kind !== "shell") await client.waitForScreen(`fake ${kind} ready`);
  return { api, task, session, client, watcher, launch };
}

function post(
  launch: Launch,
  body: string,
  token: string | null = launch.env.CORRAL_STATUS_TOKEN!,
) {
  return fetch(launch.env.CORRAL_STATUS_URL!, {
    method: "POST",
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
    body,
  });
}

test.each(["claude", "pi"] as const)(
  "%s reports after the probe: the server answers it and the status that follows reaches sessions.watch",
  async (kind) => {
    const { client, watcher } = await startAgent(kind);

    client.type(`probe ${reportBody({ state: "working", msg: "Refactoring the parser" })}\n`);

    await client.waitForScreen(`fake ${kind} probe answered`);
    const status = await watcher.until((candidate) => candidate?.state === "working", "working");
    expect(status).toEqual({
      state: "working",
      message: "Refactoring the parser",
      updatedAt: expect.any(Number),
    });
    await watcher.stop();
  },
);

test("codex reports without waiting for a probe", async () => {
  const { client, watcher } = await startAgent("codex");

  client.type(`osc ${reportBody({ state: "working" })}\n`);
  await watcher.until((status) => status?.state === "working", "working");
  client.type(`osc ${reportBody({ state: "idle" })}\n`);
  await watcher.until((status) => status?.state === "idle", "idle");

  expect(watcher.statuses.map((status) => status?.state ?? null)).toEqual([
    null,
    "working",
    "idle",
  ]);
  await watcher.stop();
});

test("a blocked subagent makes the session blocked with its kind and message; clearing it restores the root", async () => {
  const { client, watcher } = await startAgent("claude");

  client.type(`osc ${reportBody({ state: "working", msg: "Refactoring" })}\n`);
  await watcher.until((status) => status?.state === "working", "working");
  client.type(
    `osc ${reportBody({ id: "sub/1", state: "blocked", kind: "permission", msg: "Write a.ts?" })}\n`,
  );
  const blocked = await watcher.until((status) => status?.state === "blocked", "blocked");
  client.type(`osc ${reportBody({ id: "sub/1", state: "clear" })}\n`);
  await watcher.until((status) => status?.state === "working", "working again");

  expect(blocked).toMatchObject({ kind: "permission", message: "Write a.ts?" });
  expect(watcher.statuses.at(-1)).toMatchObject({ state: "working", message: "Refactoring" });
  await watcher.stop();
});

/** The session as `sessions.list` shows it once its process has exited by itself. */
async function exitedSession(api: Awaited<ReturnType<typeof startAgent>>["api"], id: string) {
  const find = async () => (await sessionsOf(api)).find((session) => session.id === id)!;
  await expect.poll(async () => (await find()).state, { timeout: 10_000 }).toBe("stopped");
  return find();
}

test.each([
  { reported: "working", kept: false },
  { reported: "blocked", kept: false },
  { reported: "idle", kept: false },
  { reported: "done", kept: true },
  { reported: "error", kept: true },
])("a $reported status is kept after the process exits: $kept", async ({ reported, kept }) => {
  const { api, session, client, watcher } = await startAgent("pi");
  client.type(`osc ${reportBody({ state: reported, msg: "Last words" })}\n`);
  await watcher.until((status) => status?.state === reported, reported);

  client.type("exit\n");
  const exited = await exitedSession(api, session.id);

  const survivor = { state: reported, message: "Last words", updatedAt: expect.any(Number) };
  expect(exited.status).toEqual(kept ? survivor : null);
  await watcher.stop();
});

test("stopping a session keeps its done, and starting it again resets the status", async () => {
  const { api, session, client, watcher } = await startAgent("claude");
  client.type(`osc ${reportBody({ state: "done", msg: "Finished" })}\n`);
  await watcher.until((status) => status?.state === "done", "done");

  const stopped = await api.sessions.stop({ id: session.id });
  expect(stopped.status).toMatchObject({ state: "done", message: "Finished" });

  const restarted = await api.sessions.restart({ id: session.id, size: SIZE });
  expect(restarted.status).toBeNull();
  await watcher.until((status) => status === null, "the reset");
  expect(watcher.statuses.map((status) => status?.state ?? null)).toEqual([null, "done", null]);
  await watcher.stop();
});

test("a status is not persisted: after a server restart the resumed agent has none until it reports", async () => {
  const { api, session, client } = await startAgent("pi");
  client.type(`osc ${reportBody({ state: "working" })}\n`);
  await expect
    .poll(async () => (await sessionsOf(api))[0]?.status?.state, { timeout: 10_000 })
    .toBe("working");

  await server.restart();

  const after = await server.rpc();
  const [resumed] = await sessionsOf(after);
  expect(resumed).toMatchObject({ id: session.id, state: "running", status: null });
});

test("a shell session takes OSC 7501 from whatever runs in it, and a new prompt ends that program", async () => {
  vi.stubEnv("SHELL", "/bin/sh");
  const { client, watcher } = await startAgent("shell");

  client.type(`printf '\\033]7501;%s\\033\\\\' 'state=working'\n`);
  await watcher.until((status) => status?.state === "working", "working");
  client.type(`printf '\\033]133;A\\007'\n`);
  await watcher.until((status) => status === null, "the prompt");

  expect(watcher.statuses.map((status) => status?.state ?? null)).toEqual([null, "working", null]);
  await watcher.stop();
});

test("the HTTP channel takes a report from the agent's launch and nothing else", async () => {
  const { api, session, watcher, launch } = await startAgent("opencode");
  const agent = (await launch())!;
  const url = new URL(agent.env.CORRAL_STATUS_URL!);
  expect(url.origin).toBe(`http://${new URL(server.url.replace("ws:", "http:")).host}`);
  expect(url.pathname).toBe(`/sessions/${session.id}/status`);

  // Refused reports leave no trace; the accepted one after them is the only status ever seen.
  expect((await post(agent, JSON.stringify({ state: "working" }), "wrong")).status).toBe(403);
  expect((await post(agent, JSON.stringify({ state: "working" }), null)).status).toBe(401);
  expect((await post(agent, "{not json")).status).toBe(400);
  expect((await post(agent, JSON.stringify({ state: "napping" }))).status).toBe(400);
  expect(
    (await post(agent, JSON.stringify({ state: "done", message: "x".repeat(2049) }))).status,
  ).toBe(400);
  expect((await post(agent, "x".repeat(100_000))).status).toBe(413);
  expect((await fetch(url, { method: "GET" })).status).toBe(405);
  const elsewhere = new URL(`/sessions/nope/status`, url);
  expect(
    (
      await fetch(elsewhere, {
        method: "POST",
        headers: { authorization: `Bearer ${agent.env.CORRAL_STATUS_TOKEN}` },
        body: JSON.stringify({ state: "working" }),
      })
    ).status,
  ).toBe(404);

  const accepted = await post(
    agent,
    JSON.stringify({ state: "blocked", kind: "permission", message: "Run rm?" }),
  );
  expect(accepted.status).toBe(204);
  await watcher.until((status) => status?.state === "blocked", "blocked");

  expect(watcher.statuses).toEqual([
    null,
    { state: "blocked", kind: "permission", message: "Run rm?", updatedAt: expect.any(Number) },
  ]);
  void api;
  await watcher.stop();
});

test("a token stops working when the session's process is replaced or gone", async () => {
  const { api, session, client } = await startAgent("opencode");
  const first = (await launchesOf(agents, "opencode", 1))[0]!;
  const body = JSON.stringify({ state: "working" });
  expect((await post(first, body)).status).toBe(204);

  await api.sessions.stop({ id: session.id });
  expect((await post(first, body)).status).toBe(403);

  await api.sessions.restart({ id: session.id, size: SIZE });
  const second = (await launchesOf(agents, "opencode", 2))[1]!;
  expect(second.env.CORRAL_STATUS_URL).toBe(first.env.CORRAL_STATUS_URL);
  expect(second.env.CORRAL_STATUS_TOKEN).not.toBe(first.env.CORRAL_STATUS_TOKEN);
  expect((await post(first, body)).status).toBe(403);
  expect((await post(second, body)).status).toBe(204);
  void client;
});

test("OSC 7501 fills in until the first HTTP report of a launch; after it the HTTP channel decides", async () => {
  const { client, watcher, launch } = await startAgent("claude");
  const agent = (await launch())!;

  client.type(`osc ${reportBody({ state: "working" })}\n`);
  await watcher.until((status) => status?.state === "working", "osc working");
  expect((await post(agent, JSON.stringify({ state: "blocked", kind: "question" }))).status).toBe(
    204,
  );
  await watcher.until((status) => status?.state === "blocked", "http blocked");
  // The marker comes through OSC after the ignored report, so the check cannot pass by being early.
  client.type(`osc ${reportBody({ state: "done" })}\n`);
  client.type(`probe ${reportBody({ state: "error" })}\n`);
  await client.waitForScreen("fake claude probe answered");
  expect((await post(agent, JSON.stringify({ state: "idle" }))).status).toBe(204);
  await watcher.until((status) => status?.state === "idle", "http idle");

  expect(watcher.statuses.map((status) => status?.state ?? null)).toEqual([
    null,
    "working",
    "blocked",
    "idle",
  ]);
  await watcher.stop();
});

test("an HTTP report that arrives after OSC ones replaces them, and an unaccepted one does not switch the channel", async () => {
  const { client, watcher, launch } = await startAgent("claude");
  const agent = (await launch())!;

  expect((await post(agent, JSON.stringify({ state: "working" }), "wrong")).status).toBe(403);
  client.type(`osc ${reportBody({ state: "blocked", kind: "permission" })}\n`);
  await watcher.until((status) => status?.state === "blocked", "osc blocked");
  client.type(`osc ${reportBody({ state: "done" })}\n`);
  await watcher.until(
    (status) => status?.state === "done",
    "osc still counts after a refused report",
  );

  expect(watcher.statuses.map((status) => status?.state ?? null)).toEqual([
    null,
    "blocked",
    "done",
  ]);
  await watcher.stop();
});

test("a new launch of the session listens to OSC 7501 again until its own first HTTP report", async () => {
  const { api, session, client, watcher } = await startAgent("claude");
  const first = (await launchesOf(agents, "claude", 1))[0]!;
  expect((await post(first, JSON.stringify({ state: "working" }))).status).toBe(204);
  await watcher.until((status) => status?.state === "working", "http working");
  // An agent that exits by itself leaves its launch listed until the restart, the path where state could leak.
  client.type("exit\n");
  await expect
    .poll(async () => (await sessionsOf(api))[0]?.state, { timeout: 10_000 })
    .toBe("stopped");
  await api.sessions.restart({ id: session.id, size: SIZE });
  await watcher.until((status) => status === null, "the reset");
  const restarted = await server.attach((await sessionsOf(api))[0]!.terminalId!);
  await restarted.waitForScreen("fake claude ready");

  restarted.type(`osc ${reportBody({ state: "blocked", kind: "auth" })}\n`);
  await watcher.until((status) => status?.state === "blocked", "osc after relaunch");

  // The earlier launch's token is dead, so it cannot take the channel back either.
  expect((await post(first, JSON.stringify({ state: "idle" }))).status).toBe(403);
  await watcher.stop();
});

test("a repeated report is not a change: watchers hear nothing and updatedAt stays", async () => {
  const { client, watcher } = await startAgent("codex");

  client.type(`osc ${reportBody({ state: "working", msg: "Same" })}\n`);
  const first = await watcher.until((status) => status?.state === "working", "working");
  client.type(`osc ${reportBody({ state: "working", msg: "Same" })}\n`);
  client.type(`osc ${reportBody({ state: "done" })}\n`);
  await watcher.until((status) => status?.state === "done", "done");

  expect(watcher.statuses.map((status) => status?.state ?? null)).toEqual([
    null,
    "working",
    "done",
  ]);
  expect(watcher.statuses[1]!.updatedAt).toBe(first!.updatedAt);
  await watcher.stop();
});

test("every agent gets the status endpoint; only OpenCode is started with the plugin", async () => {
  const { api, task } = await addTask(server, "Env");
  const kinds = ["claude", "codex", "pi", "opencode"] as const;
  const sessions: Session[] = await Promise.all(
    kinds.map((kind) => api.sessions.start({ taskId: task.id, kind, size: SIZE })),
  );
  const launches = await Promise.all(
    kinds.map(async (kind) => (await launchesOf(agents, kind, 1))[0]!),
  );

  const tokens = new Set(launches.map((launch) => launch.env.CORRAL_STATUS_TOKEN));
  expect(tokens.size).toBe(4);
  for (const [index, launch] of launches.entries()) {
    expect(launch.env.CORRAL_STATUS_URL).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:\\d+/sessions/${sessions[index]!.id}/status$`),
    );
    expect(launch.env.CORRAL_STATUS_TOKEN!.length).toBeGreaterThanOrEqual(32);
  }
  const [claude, , pi, opencode] = launches;
  expect(claude!.argv).not.toContain("--standalone");
  expect(pi!.argv).not.toContain("--standalone");
  expect(opencode!.argv.slice(0, 1)).toEqual(["--standalone"]);
});

test("OpenCode is started with the plugin from the server's data directory, merged into the user's config", async () => {
  const { api, task } = await addTask(server, "Plugin");
  await api.sessions.start({ taskId: task.id, kind: "opencode", size: SIZE });
  const [launch] = await launchesOf(agents, "opencode", 1);

  const pluginDir = join(server.dataDir, "agent-integrations", "opencode", "corral-status");
  expect(launch!.opencode).toEqual({
    configContent: JSON.stringify({ plugins: [{ package: pluginDir }] }),
    pluginDir,
    pluginPresent: true,
  });
  expect(await readFile(join(pluginDir, "index.js"), "utf8")).toContain("corral.status");
});

test("OpenCode launched with the user's own inline config gets no plugin; the server says so once", async () => {
  vi.stubEnv("OPENCODE_CONFIG_CONTENT", '{"theme":"mine"}');
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { api, task } = await addTask(server, "Own config");
  await api.sessions.start({ taskId: task.id, kind: "opencode", size: SIZE });
  await api.sessions.start({ taskId: task.id, kind: "opencode", size: SIZE });

  const launches = await launchesOf(agents, "opencode", 2);

  for (const launch of launches) {
    expect(launch.argv).not.toContain("--standalone");
    expect(launch.opencode).toEqual({ configContent: '{"theme":"mine"}', pluginPresent: false });
  }
  expect(warn).toHaveBeenCalledTimes(1);
  warn.mockRestore();
});

test("the OpenCode fake reports over the HTTP channel as the plugin does", async () => {
  const { client, watcher } = await startAgent("opencode");

  client.type(
    `post ${JSON.stringify({ state: "blocked", kind: "question", message: "Which?" })}\n`,
  );

  await client.waitForScreen("fake opencode posted 204");
  const status = await watcher.until((candidate) => candidate?.state === "blocked", "blocked");
  expect(status).toMatchObject({ kind: "question", message: "Which?" });
  await watcher.stop();
});
