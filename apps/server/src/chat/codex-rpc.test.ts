import type { ChatSnapshot } from "@corral/protocol/chat";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { resetCodexVersionCache } from "../agents/codex-version.ts";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { addProject } from "../../test/project-fixture.ts";
import { frontendArgs, sessionsOf } from "../../test/session-helpers.ts";
import { useServer, within } from "../../test/server-fixture.ts";
import type { Launch } from "../../test/fake-agents.ts";

const server = useServer({
  chat: { dialogTimeoutMs: 2000, readyTimeoutMs: 6000, exitGraceMs: 400, writerWaitMs: 2000 },
});
const agents = useFakeAgents();
const SIZE = { cols: 80, rows: 24 };

// The version is cached per executable; a test may swap it.
beforeEach(() => {
  resetCodexVersionCache();
});

type Api = Awaited<ReturnType<typeof server.rpc>>;

async function codexTask(view: "chat" | "terminal", prompt = "stream please", projectId?: string) {
  const project = projectId === undefined ? (await addProject(server)).project : { id: projectId };
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt,
    agent: { kind: "codex", view },
    workspace: { type: "new-branch" },
  });
  const session = (await sessionsOf(api)).find((each) => each.id === task.primarySessionId);
  expect(session, "the task's primary codex session").toBeDefined();
  return { api, task, session: session!, projectId: project.id };
}

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

function textOf(view: ChatSnapshot): string {
  return view.items
    .flatMap((item) => (item.kind === "assistant-message" ? [item.text] : []))
    .join("");
}

async function until<T>(
  read: () => Promise<T[]>,
  count: number,
  description: string,
): Promise<T[]> {
  const deadline = Date.now() + 10_000;
  let latest: T[] = [];
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling the launch journal is the point
    latest = await read();
    if (latest.length >= count) return latest;
    // oxlint-disable-next-line no-await-in-loop -- see above
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${description}; got ${JSON.stringify(latest)}`);
}

async function appServerLaunches(): Promise<Launch[]> {
  return (await agents.launches()).filter((launch) => launch.argv[0] === "app-server");
}

test(
  "a Codex chat task streams, stores the assigned thread id, and opens its terminal as a second client of one app-server",
  { timeout: 30_000 },
  async () => {
    const { api, session } = await codexTask("chat");
    const capabilities = await api.chat.capabilities();
    expect(capabilities.drivers).toContainEqual({
      kind: "codex",
      steer: true,
      followUp: false,
      approvals: true,
      modelSwitch: false,
      reasoningLevels: false,
      terminalView: "both-live",
    });
    const settled = await untilChat(
      api,
      session.id,
      (view) => textOf(view).includes("the stub answer") && view.state.turn === "settled",
      "the streamed turn",
    );
    expect(settled.items.find((item) => item.kind === "user-message")).toMatchObject({
      text: "stream please",
    });
    // `thread/start` assigns the id, so the session row learns it from the driver.
    const stored = (await sessionsOf(api)).find((each) => each.id === session.id);
    expect(stored?.agentSessionId).toMatch(/^thr-/);

    // The terminal view is `codex --remote unix://<data dir>/codex/<session>.sock …` and attaches
    // beside the live chat frontend: one app-server, two clients.
    const switched = await api.sessions.setView({ id: session.id, view: "terminal", size: SIZE });
    expect(switched).toMatchObject({ view: "terminal", state: "running", kind: "codex" });
    const terminal = await until(
      async () =>
        (await agents.launches()).filter(
          (launch) => launch.agent === "codex" && launch.argv.includes("--remote"),
        ),
      1,
      "the terminal leg to attach with --remote",
    );
    expect(terminal[0]?.argv.slice(0, 2)).toEqual([
      "--remote",
      `unix://${server.dataDir}/codex/${session.id}.sock`,
    ]);
    expect(await appServerLaunches()).toHaveLength(1);
    // The chat frontend is still live under the terminal view.
    expect(textOf(await timelineOf(api, session.id))).toContain("the stub answer");
  },
);

test(
  "a terminal-first Codex session opens chat beside its terminal without a second app-server",
  { timeout: 30_000 },
  async () => {
    const { api, session } = await codexTask("terminal");
    expect(session).toMatchObject({ view: "terminal", kind: "codex", state: "running" });
    expect(await appServerLaunches()).toHaveLength(1);

    const switched = await api.sessions.setView({ id: session.id, view: "chat", size: SIZE });
    expect(switched).toMatchObject({ view: "chat", state: "running" });
    await untilChat(
      api,
      session.id,
      (view) => view.items.length > 0,
      "the chat frontend on the terminal's app-server",
    );
    expect(await appServerLaunches()).toHaveLength(1);
    const stored = (await sessionsOf(api)).find((each) => each.id === session.id);
    expect(stored?.agentSessionId).toMatch(/^thr-/);
  },
);

test(
  "an untested Codex version refuses chat with a sentence and keeps the terminal launch plain",
  { timeout: 30_000 },
  async () => {
    vi.stubEnv("FAKE_CODEX_VERSION", "0.165.0");
    resetCodexVersionCache();
    const refused = await codexTask("chat");
    expect(refused.session.state).toBe("stopped");
    expect(refused.session.launchError).toContain("0.165.0");
    expect(refused.session.launchError).toContain("0.166.0");
    expect(refused.session.launchError).toContain("terminal");
    // Nothing was spawned for the refused chat.
    expect(await appServerLaunches()).toHaveLength(0);

    // The terminal stays available, and it is the plain stage A launch (no Corral app-server).
    const terminal = await codexTask("terminal", "stream please", refused.projectId);
    expect(terminal.session.state).toBe("running");
    const launches = (await agents.launches()).filter((launch) => launch.agent === "codex");
    expect(launches.some((launch) => launch.argv.includes("--remote"))).toBe(false);
  },
);

test("the app-server leaves no record behind when its last client stops", async () => {
  const { api, session } = await codexTask("chat");
  await untilChat(api, session.id, (view) => view.items.length > 0, "the chat frontend");
  const before = (await sessionsOf(api)).find((each) => each.id === session.id);
  await api.sessions.stop({ id: session.id });
  // The pool's record is gone with the process: a restart starts a fresh server on the same thread.
  const restarted = await api.sessions.restart({ id: session.id, size: SIZE });
  expect(restarted.state).toBe("running");
  expect(restarted.agentSessionId).toBe(before?.agentSessionId);
  expect(await appServerLaunches()).toHaveLength(2);
});

test(
  "a crashed app-server closes the terminal leg and settles the session, and a normal stop does not",
  { timeout: 30_000 },
  async () => {
    const { api, session } = await codexTask("terminal");
    const client = await server.attach(session.terminalId!);
    await client.waitForScreen("fake codex ready");

    // A normal stop is not a crash: no `launchError` is recorded for a stop the session asked for.
    const stopped = await api.sessions.stop({ id: session.id });
    expect(stopped.state).toBe("stopped");
    expect(stopped.launchError).toBeNull();
    const restarted = await api.sessions.restart({ id: session.id, size: SIZE });
    expect(restarted.state).toBe("running");
    const again = await server.attach(restarted.terminalId!);
    await again.waitForScreen("fake codex ready");

    // The app-server dies under the live terminal: the PTY is closed with it and the session
    // settles instead of showing "Reconnecting to server…" forever.
    const record = JSON.parse(
      await readFile(join(server.dataDir, "chat", `codex-server-${session.id}.json`), "utf8"),
    ) as { pid: number };
    process.kill(record.pid, "SIGKILL");
    const settled = await within(
      (async () => {
        for (;;) {
          // oxlint-disable-next-line no-await-in-loop -- polling for the settle is the point
          const current = (await sessionsOf(api)).find((each) => each.id === session.id);
          if (current?.state === "stopped") return current;
          // oxlint-disable-next-line no-await-in-loop -- see above
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      })(),
      "the session to settle after the app-server died",
    );
    expect(settled.launchError).toContain("codex app-server");
    expect(settled.terminalId).toBeNull();
  },
);

test(
  "a chat-first session opens its thread with the launch's model, not the app-server default",
  { timeout: 30_000 },
  async () => {
    const { api, task } = await codexTaskWithOptions();
    const session = await api.sessions.start({
      taskId: task.id,
      kind: "codex",
      view: "chat",
      size: SIZE,
      model: "stub-alt",
    });
    const current = (await sessionsOf(api)).find((each) => each.id === session.id)!;
    expect(current).toMatchObject({ state: "running" });
    // The thread the driver opened carries the launch's model, not the app-server's default.
    await expect
      .poll(async () => (await threadRecord(server.dataDir, session.id))?.["model"], {
        timeout: 10_000,
      })
      .toBe("stub-alt");
  },
);

test(
  "a chat thread the terminal started is not overwritten by a late rollout, and a non-durable one starts a new conversation",
  { timeout: 40_000 },
  async () => {
    // 1. The terminal writes its rollout only on the first line; chat opens before that.
    vi.stubEnv("FAKE_CODEX_ROLLOUT", "lazy");
    const { api, task } = await codexTask("terminal");
    const session = (await sessionsOf(api)).find((each) => each.id === task.primarySessionId)!;
    const client = await server.attach(session.terminalId!);
    await client.waitForScreen("fake codex ready");
    const switched = await api.sessions.setView({ id: session.id, view: "chat", size: SIZE });
    expect(switched.view).toBe("chat");
    await untilChat(api, session.id, (view) => view.items.length > 0, "the chat frontend");
    const chatId = (await sessionsOf(api)).find((each) => each.id === session.id)?.agentSessionId;
    expect(chatId).toMatch(/^thr-/);
    client.type("hello from the terminal\n");
    await client.waitForScreen("fake codex got: hello from the terminal");
    // The late rollout does not take the session over.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await sessionsOf(api)).find((each) => each.id === session.id)?.agentSessionId).toBe(
      chatId,
    );
    // The terminal's late rollout did become a conversation of its own; it just is not this row's.
    const terminal = (await agents.launches())
      .filter((entry) => entry.agent === "codex" && entry.rolloutId !== undefined)
      .at(-1);
    expect(terminal?.rolloutId).not.toBe(chatId);
  },
);

test(
  "a chat thread with no rollout cannot be resumed as a terminal, so the terminal starts a new conversation",
  { timeout: 30_000 },
  async () => {
    vi.stubEnv("FAKE_CODEX_NO_ROLLOUT", "1");
    vi.stubEnv("FAKE_CODEX_ROLLOUT", "never");
    const { api, session } = await codexTask("chat");
    await untilChat(api, session.id, (view) => view.items.length > 0, "the chat frontend");
    const chatId = (await sessionsOf(api)).find((each) => each.id === session.id)?.agentSessionId;
    expect(chatId).toMatch(/^thr-/);

    await api.sessions.setView({ id: session.id, view: "terminal", size: SIZE });
    const launches = await until(
      async () =>
        (await agents.launches()).filter(
          (launch) => launch.agent === "codex" && launch.argv.includes("--remote"),
        ),
      1,
      "the terminal leg to attach",
    );
    const last = launches.at(-1)!;
    // No `resume <chatId>`: that thread has no rollout, so the launch starts fresh with the prompt.
    expect(frontendArgs(last.argv)).toEqual(["--", "stream please"]);
  },
);

/** A task with no primary session yet, for a `sessions.start` the test configures itself. */
async function codexTaskWithOptions() {
  const project = (await addProject(server)).project;
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "stream please",
    workspace: { type: "new-branch" },
  });
  return { api, task };
}

/** The fake app-server's journaled thread record for this session's socket. */
async function threadRecord(
  dataDir: string,
  sessionId: string,
): Promise<Record<string, unknown> | undefined> {
  const text = await readFile(join(dataDir, "codex", `${sessionId}.sock.journal`), "utf8").catch(
    () => "",
  );
  const records = text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { thread?: Record<string, unknown> });
  return records.at(-1)?.thread;
}
