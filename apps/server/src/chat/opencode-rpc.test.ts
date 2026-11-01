import type { ChatItem, ChatSnapshot } from "@corral/protocol/chat";
import { readFile } from "node:fs/promises";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { isRecord } from "../../test/json.ts";
import { addProject } from "../../test/project-fixture.ts";
import { useServer } from "../../test/server-fixture.ts";
import { sessionsOf } from "../../test/session-helpers.ts";

const server = useServer({
  chat: { dialogTimeoutMs: 2000, readyTimeoutMs: 4000, exitGraceMs: 400, writerWaitMs: 2000 },
});
const agents = useFakeAgents();
const SIZE = { cols: 80, rows: 24 };

// The TUI launch records the password it was handed, so the test can say it was the server's.
beforeEach(() => {
  vi.stubEnv("FAKE_AGENT_LOG_ENV", "OPENCODE_SERVER_PASSWORD");
});

type Api = Awaited<ReturnType<typeof server.rpc>>;

/** A task whose primary session is an OpenCode chat session with `prompt`. */
async function openCodeTask(
  prompt = "stream please",
  workspace: "main-worktree" | "new-branch" = "new-branch",
  projectId?: string,
) {
  const project = projectId === undefined ? (await addProject(server)).project : { id: projectId };
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt,
    agent: { kind: "opencode", view: "chat" },
    workspace: { type: workspace },
  });
  const session = (await sessionsOf(api)).find((each) => each.id === task.primarySessionId);
  expect(session, "the task's primary opencode chat session").toBeDefined();
  return { api, task, session: session!, projectId: project.id };
}

/** The current whole timeline: one `chat.watch` that only reads its first snapshot. */
async function timelineOf(api: Api, sessionId: string): Promise<ChatSnapshot> {
  const stream = await api.chat.watch({ sessionId });
  const iterator = stream[Symbol.asyncIterator]();
  const first = await iterator.next();
  await iterator.return?.(undefined);
  if (first.done === true) throw new Error("the chat stream ended before its snapshot");
  if (first.value.type !== "snapshot") throw new Error("the first message was not a snapshot");
  return first.value.snapshot;
}

async function untilChat(
  api: Api,
  sessionId: string,
  predicate: (view: ChatSnapshot) => boolean,
  description: string,
): Promise<ChatSnapshot> {
  const deadline = Date.now() + 15_000;
  let latest: ChatSnapshot | undefined;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling the server's snapshot is the point
    latest = await timelineOf(api, sessionId);
    if (predicate(latest)) return latest;
    // oxlint-disable-next-line no-await-in-loop -- see above
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`timed out waiting for ${description}: ${JSON.stringify(latest?.items)}`);
}

function itemOf<K extends ChatItem["kind"]>(
  snapshot: ChatSnapshot,
  kind: K,
): Extract<ChatItem, { kind: K }> | undefined {
  return snapshot.items.find((item): item is Extract<ChatItem, { kind: K }> => item.kind === kind);
}

function textOf(snapshot: ChatSnapshot): string {
  return snapshot.items
    .flatMap((item) => (item.kind === "assistant-message" ? [item.text] : []))
    .join("");
}

async function openCodeJournal(): Promise<Record<string, unknown>[]> {
  const text = await readFile(agents.openCodeLog, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as unknown)
    .filter(isRecord);
}

async function serveLaunches() {
  return (await agents.launches()).filter((launch) => launch.argv[0] === "serve");
}

test("an OpenCode chat task streams on the one server it starts, and opens its terminal as a client of it", async () => {
  const { api, session } = await openCodeTask();
  const capabilities = await api.chat.capabilities();
  expect(capabilities.drivers).toContainEqual({
    kind: "opencode",
    steer: true,
    followUp: true,
    approvals: true,
    modelSwitch: false,
    reasoningLevels: false,
    terminalView: "both-live",
  });
  expect(session).toMatchObject({ view: "chat", kind: "opencode", terminalId: null });

  const streamed = await untilChat(
    api,
    session.id,
    (view) => textOf(view).includes("Hello world") && view.state.turn === "settled",
    "the streamed turn",
  );
  expect(itemOf(streamed, "user-message")).toMatchObject({ text: "stream please" });
  expect(itemOf(streamed, "tool-call")).toMatchObject({
    name: "edit",
    status: "done",
    diff: { path: "src/app.ts" },
  });
  expect(await serveLaunches()).toHaveLength(1);
  const [serve] = await serveLaunches();
  expect(serve).toMatchObject({ agent: "opencode" });
  const serveArgv = serve!.argv;
  expect(serveArgv.slice(0, 5)).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0"]);

  // `prefix v` for a both-live driver opens the terminal beside the chat: a terminal launch with
  // the server's url and the session id, while the chat driver keeps running.
  const opened = await api.sessions.setView({ id: session.id, view: "terminal", size: SIZE });
  expect(opened).toMatchObject({ view: "terminal", terminalId: expect.any(String) });

  await expect
    .poll(
      async () => (await agents.launches()).filter((launch) => launch.agent === "opencode").length,
      {
        timeout: 15_000,
        message: "the TUI launching beside chat",
      },
    )
    .toBe(2);
  const tui = (await agents.launches()).find(
    (launch) => launch.agent === "opencode" && launch.argv[0] !== "serve",
  );
  const tuiClient = async () =>
    (await openCodeJournal()).find(
      (entry) => entry["action"] === "client" && entry["client"] === "tui",
    );
  await expect
    .poll(tuiClient, { timeout: 10_000, message: "the TUI announcing itself to the server" })
    .toBeDefined();
  const attach = await tuiClient();
  expect(tui!.argv).toEqual([
    "--server",
    expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
    "--session",
    session.agentSessionId,
  ]);
  expect(tui!.envSentinels["OPENCODE_SERVER_PASSWORD"]).toEqual(expect.any(String));
  // One server, two kinds of client: the driver's event stream and the TUI.
  expect(await serveLaunches()).toHaveLength(1);
  expect(attach).toBeDefined();
  const streams = (await openCodeJournal()).filter((entry) => entry["action"] === "event-stream");
  expect(streams.length).toBeGreaterThanOrEqual(1);
  expect(streams[0]).toMatchObject({ clients: expect.any(Number) });

  // The chat is still live while the terminal is the shown view: one prompt writer, the driver.
  await api.chat.send({ sessionId: session.id, text: "a steer", mode: "steer" });
  await expect
    .poll(
      async () => (await openCodeJournal()).filter((entry) => entry["action"] === "prompt").length,
      {
        timeout: 5000,
        message: "the steer reaching the server",
      },
    )
    .toBe(2);
  const prompts = (await openCodeJournal()).filter((entry) => entry["action"] === "prompt");
  expect(prompts.map((entry) => entry["delivery"])).toEqual([null, "steer"]);

  // Opening the chat again adds no frontend: both legs are already live.
  const back = await api.sessions.setView({ id: session.id, view: "chat", size: SIZE });
  expect(back).toMatchObject({ view: "chat", terminalId: expect.any(String) });
  expect(await serveLaunches()).toHaveLength(1);
  expect((await agents.launches()).filter((launch) => launch.argv[0] !== "serve")).toHaveLength(1);
});

test("two OpenCode sessions share the run's server, and the last stop ends it", async () => {
  const first = await openCodeTask("stream first");
  const second = await openCodeTask("stream second", "main-worktree", first.projectId);
  expect(first.session.id).not.toBe(second.session.id);
  await untilChat(
    first.api,
    first.session.id,
    (view) => view.state.turn === "settled",
    "the first turn",
  );
  await untilChat(
    second.api,
    second.session.id,
    (view) => view.state.turn === "settled",
    "the second turn",
  );
  expect(await serveLaunches()).toHaveLength(1);
  const creations = (await openCodeJournal()).filter(
    (entry) => entry["action"] === "session-create",
  );
  expect(creations.map((entry) => String(entry["sessionID"])).toSorted()).toEqual(
    [first.session.agentSessionId, second.session.agentSessionId]
      .map((id) => String(id))
      .toSorted(),
  );

  await first.api.sessions.stop({ id: first.session.id });
  expect((await openCodeJournal()).some((entry) => entry["action"] === "exit")).toBe(false);
  await second.api.sessions.stop({ id: second.session.id });
  await expect
    .poll(async () => (await openCodeJournal()).some((entry) => entry["action"] === "exit"), {
      timeout: 10_000,
      message: "the server stopping with its last session",
    })
    .toBe(true);
});

test("a killed server is a typed refusal with the reason, and a restart recreates the session under Corral's id", async () => {
  const { api, session } = await openCodeTask();
  await untilChat(
    api,
    session.id,
    (view) => textOf(view).includes("Hello world") && view.state.turn === "settled",
    "the first turn",
  );
  const pid = (await openCodeJournal()).find((entry) => entry["action"] === "listen")?.["pid"];
  expect(typeof pid).toBe("number");
  if (typeof pid !== "number") throw new Error("the fake server did not journal its pid");
  process.kill(pid, "SIGKILL");

  await expect
    .poll(async () => (await sessionsOf(api)).find((each) => each.id === session.id)?.state, {
      timeout: 10_000,
      message: "the session settling after the server died",
    })
    .toBe("stopped");
  const settled = (await sessionsOf(api)).find((each) => each.id === session.id)!;
  expect(settled.launchError).toEqual(expect.stringContaining("opencode server"));
  await expect(
    api.chat.send({ sessionId: session.id, text: "hi", mode: "prompt" }),
  ).rejects.toMatchObject({ code: "CHAT_UNAVAILABLE", data: { reason: "exited" } });

  const restarted = await api.sessions.restart({ id: session.id, size: SIZE });
  expect(restarted).toMatchObject({
    id: session.id,
    state: "running",
    agentSessionId: session.agentSessionId,
    view: "chat",
  });
  const rebuilt = await untilChat(
    api,
    session.id,
    (view) => textOf(view).includes("Hello world"),
    "the transcript rebuilt on the new server",
  );
  expect(itemOf(rebuilt, "user-message")).toMatchObject({ text: "stream please" });
  // A new server process, the same Corral session id: the launch asked for it by name.
  expect(await serveLaunches()).toHaveLength(2);
  const creations = (await openCodeJournal()).filter(
    (entry) => entry["action"] === "session-create",
  );
  expect(creations.every((entry) => entry["sessionID"] === session.agentSessionId)).toBe(true);
});

async function sessionNow(api: Api, id: string) {
  return (await sessionsOf(api)).find((session) => session.id === id);
}

async function promptsOf(): Promise<Record<string, unknown>[]> {
  return (await openCodeJournal()).filter((entry) => entry["action"] === "prompt");
}

test("stopping and restarting a chat session at once keeps it running and never repeats the prompt", async () => {
  const { api, session } = await openCodeTask("stream please");
  await untilChat(
    api,
    session.id,
    (view) => textOf(view).includes("Hello world") && view.state.turn === "settled",
    "the first turn",
  );
  expect(await promptsOf()).toHaveLength(1);

  // Same tick: the restart asks for the server while the stop is still shutting it down.
  await api.sessions.stop({ id: session.id });
  const restarted = await api.sessions.restart({ id: session.id, size: SIZE });

  expect(restarted).toMatchObject({ id: session.id, state: "running" });
  expect(restarted.launchError).toBeNull();
  await untilChat(
    api,
    session.id,
    (view) => textOf(view).includes("Hello world") && view.state.turn === "settled",
    "the transcript rebuilt after the restart",
  );
  expect(await promptsOf()).toHaveLength(1);
  expect(await serveLaunches()).toHaveLength(2);
});

test("a chat view opened after the terminal never repeats the prompt of a session that has history", async () => {
  const { api, session } = await openCodeTask("stream please");
  await untilChat(
    api,
    session.id,
    (view) => textOf(view).includes("Hello world") && view.state.turn === "settled",
    "the first turn",
  );
  expect(await promptsOf()).toHaveLength(1);

  await api.sessions.stop({ id: session.id });
  await api.sessions.setView({ id: session.id, view: "terminal", size: SIZE });
  const terminal = await api.sessions.restart({ id: session.id, size: SIZE });
  expect(terminal).toMatchObject({ view: "terminal", terminalId: expect.any(String) });

  const chat = await api.sessions.setView({ id: session.id, view: "chat", size: SIZE });
  expect(chat).toMatchObject({ view: "chat", terminalId: expect.any(String) });
  await untilChat(
    api,
    session.id,
    (view) => textOf(view).includes("Hello world"),
    "the transcript in the chat view",
  );
  expect(await promptsOf()).toHaveLength(1);
});

test("opening the terminal keeps the live chat driver's status, and its later reports still land", async () => {
  const { api, session } = await openCodeTask("ask");
  await untilChat(
    api,
    session.id,
    (view) => itemOf(view, "user-request")?.status === "pending",
    "the permission request",
  );
  await expect
    .poll(async () => (await sessionNow(api, session.id))?.status?.state, { timeout: 10_000 })
    .toBe("blocked");

  const opened = await api.sessions.setView({ id: session.id, view: "terminal", size: SIZE });
  expect(opened).toMatchObject({ view: "terminal", terminalId: expect.any(String) });
  // The terminal leg must not erase what the chat driver reported or stop its future reports.
  expect((await sessionNow(api, session.id))?.status?.state).toBe("blocked");

  const pending = await untilChat(
    api,
    session.id,
    (view) => itemOf(view, "user-request")?.status === "pending",
    "the request still pending",
  );
  await api.chat.respond({
    sessionId: session.id,
    requestId: itemOf(pending, "user-request")!.id,
    value: "once",
  });
  await untilChat(api, session.id, (view) => view.state.turn === "settled", "the settled turn");
  await expect
    .poll(async () => (await sessionNow(api, session.id))?.status?.state, { timeout: 10_000 })
    .toBe("done");
});
