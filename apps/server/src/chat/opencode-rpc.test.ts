import type { ChatItem, ChatSnapshot } from "@corral/protocol/chat";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { isRecord } from "../../test/json.ts";
import { addProject } from "../../test/project-fixture.ts";
import { useServer } from "../../test/server-fixture.ts";
import { sessionsOf } from "../../test/session-helpers.ts";

let terminalBarrier:
  | { entered: PromiseWithResolvers<string>; release: PromiseWithResolvers<void> }
  | undefined;

const server = useServer({
  chat: { dialogTimeoutMs: 2000, readyTimeoutMs: 4000, exitGraceMs: 400, writerWaitMs: 2000 },
  beforeOpenCodeTerminal: async (sessionId) => {
    const barrier = terminalBarrier;
    if (barrier === undefined) return;
    terminalBarrier = undefined;
    barrier.entered.resolve(sessionId);
    await barrier.release.promise;
  },
});
const agents = useFakeAgents();
const SIZE = { cols: 80, rows: 24 };

// The TUI launch records the password it was handed, so the test can say it was the server's.
beforeEach(() => {
  terminalBarrier = undefined;
  vi.stubEnv("FAKE_AGENT_LOG_ENV", "OPENCODE_SERVER_PASSWORD");
});

function holdTerminal() {
  const barrier = {
    entered: Promise.withResolvers<string>(),
    release: Promise.withResolvers<void>(),
  };
  terminalBarrier = barrier;
  return barrier;
}

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

/** The model switches the fake server journaled, in request order. */
async function modelSwitches(): Promise<Record<string, unknown>[]> {
  return (await openCodeJournal()).filter((entry) => entry["action"] === "model-switch");
}

/** A scenario file for the fake server, read on the request it applies to. */
async function fakeScenario(name: string, value: string): Promise<void> {
  await mkdir(agents.openCodeState, { recursive: true });
  await writeFile(join(agents.openCodeState, name), value);
}

test("OpenCode runs a queued turn and subsequent ordinary prompts after delivery and execution", async () => {
  const { api, session } = await openCodeTask("slow");
  await untilChat(api, session.id, (view) => view.state.turn === "working", "the first turn");
  await api.chat.send({ sessionId: session.id, text: "queued later", mode: "follow-up" });
  await untilChat(
    api,
    session.id,
    (view) =>
      view.items.some((item) => item.kind === "user-message" && item.text === "queued later") &&
      view.state.turn === "settled" &&
      (view.state.queue?.length ?? 0) === 0,
    "the queued completed turn",
  );
  for (const text of ["first normal", "second normal"]) {
    // oxlint-disable-next-line no-await-in-loop -- each turn follows the preceding boundary
    await api.chat.send({ sessionId: session.id, text, mode: "prompt" });
    // oxlint-disable-next-line no-await-in-loop -- the next prompt waits for this turn
    await untilChat(
      api,
      session.id,
      (view) =>
        view.items.some((item) => item.kind === "user-message" && item.text === text) &&
        view.state.turn === "settled" &&
        (view.state.queue?.length ?? 0) === 0,
      text,
    );
  }
  const sent = (await openCodeJournal()).filter((entry) => entry["action"] === "prompt");
  expect(sent.map((entry) => entry["text"])).toEqual([
    "slow",
    "queued later",
    "first normal",
    "second normal",
  ]);
});

test("an exited both-live terminal wakes the queued chat turn", async () => {
  vi.stubEnv("FAKE_OPENCODE_SLOW_MS", "3000");
  try {
    const { api, session } = await openCodeTask("slow");
    await untilChat(api, session.id, (view) => view.state.turn === "working", "the first turn");
    const opened = await api.sessions.setView({ id: session.id, view: "terminal", size: SIZE });
    await api.sessions.setView({ id: session.id, view: "chat", size: SIZE });
    await api.chat.send({
      sessionId: session.id,
      text: "queued after terminal",
      mode: "follow-up",
    });
    await untilChat(
      api,
      session.id,
      (view) =>
        view.state.turn === "settled" &&
        view.state.queue?.some(
          (entry) => entry.text === "queued after terminal" && entry.status === "queued",
        ) === true,
      "the turn held by the live terminal",
    );
    await expect
      .poll(
        async () =>
          (await agents.launches()).find(
            (launch) => launch.agent === "opencode" && launch.argv[0] !== "serve",
          ),
        { timeout: 10_000 },
      )
      .toBeDefined();
    const tui = (await agents.launches()).find(
      (launch) => launch.agent === "opencode" && launch.argv[0] !== "serve",
    )!;
    process.kill(tui.pid, "SIGTERM");
    await untilChat(
      api,
      session.id,
      (view) =>
        view.items.some(
          (item) => item.kind === "user-message" && item.text === "queued after terminal",
        ),
      "the queued turn after terminal exit",
    );
    expect(await api.terminals.list()).toContainEqual(
      expect.objectContaining({ id: opened.terminalId, exit: expect.any(Object) }),
    );
    expect(
      (await openCodeJournal())
        .filter((entry) => entry["action"] === "prompt")
        .map((entry) => entry["text"]),
    ).toEqual(["slow", "queued after terminal"]);
  } finally {
    vi.stubEnv("FAKE_OPENCODE_SLOW_MS", undefined);
  }
}, 20_000);

test("an OpenCode steer keeps the running model, while the queued turn starts on the model it captured", async () => {
  vi.stubEnv("FAKE_OPENCODE_SLOW_MS", "1200");
  const { api, session } = await openCodeTask("slow");
  try {
    await untilChat(api, session.id, (view) => view.state.turn === "working", "the first turn");
    const B = { provider: "other", id: "other-model" };
    const C = { provider: "stub", id: "stub-model" };
    await api.chat.setModel({ sessionId: session.id, model: B });
    await api.chat.send({ sessionId: session.id, text: "steer on A", mode: "steer" });
    await api.chat.send({ sessionId: session.id, text: "queued on B", mode: "follow-up" });
    const captured = await untilChat(
      api,
      session.id,
      (view) => view.state.queue?.some((entry) => entry.text === "queued on B") ?? false,
      "the queued entry",
    );
    expect(captured.state.queue?.find((entry) => entry.text === "queued on B")).toMatchObject({
      selection: { model: B, level: null },
    });
    await api.chat.setModel({ sessionId: session.id, model: C });

    // Nothing moved the session to B while the first turn ran: no prompt so far has needed a
    // switch, and the steer is the same turn's message.
    expect(
      (await modelSwitches()).filter(
        (entry) => isRecord(entry["model"]) && entry["model"]["id"] === "other-model",
      ),
    ).toEqual([]);
    expect(captured.state.model).toMatchObject({ provider: "stub", id: "stub-model" });

    const settled = await untilChat(
      api,
      session.id,
      (view) =>
        view.items.some((item) => item.kind === "user-message" && item.text === "queued on B") &&
        view.state.turn === "settled" &&
        (view.state.queue?.length ?? 0) === 0,
      "the queued turn on B",
    );
    const entries = await openCodeJournal();
    const steer = entries.findIndex(
      (entry) => entry["action"] === "prompt" && entry["text"] === "steer on A",
    );
    const switched = entries.findIndex(
      (entry) =>
        entry["action"] === "model-switch" &&
        isRecord(entry["model"]) &&
        entry["model"]["id"] === "other-model",
    );
    const queued = entries.findIndex(
      (entry) => entry["action"] === "prompt" && entry["text"] === "queued on B",
    );
    expect(steer).toBeGreaterThanOrEqual(0);
    expect(entries[steer]).toMatchObject({ delivery: "steer" });
    expect(switched).toBeGreaterThan(steer);
    expect(entries[switched]).toMatchObject({ model: { id: "other-model", providerID: "other" } });
    expect(switched).toBeLessThan(queued);
    // C is the composer's next choice; the queued turn did not run on it.
    expect(settled.state.selection).toEqual({ model: C, level: null });
    const switches = await modelSwitches();
    expect(switches.at(-1)).toMatchObject({ model: { id: "other-model", providerID: "other" } });
    expect(
      switches.filter(
        (entry) => isRecord(entry["model"]) && entry["model"]["id"] === "other-model",
      ),
    ).toHaveLength(1);
  } finally {
    vi.stubEnv("FAKE_OPENCODE_SLOW_MS", undefined);
  }
});

test("an OpenCode task created with a chosen model starts on it without a redundant switch", async () => {
  const project = (await addProject(server)).project;
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "stream please",
    agent: {
      kind: "opencode",
      view: "chat",
      expectedModel: { provider: "other", id: "other-model" },
    },
    workspace: { type: "new-branch" },
  });
  const session = (await sessionsOf(api)).find((each) => each.id === task.primarySessionId);
  expect(session).toBeDefined();
  const settled = await untilChat(
    api,
    session!.id,
    (view) => textOf(view).includes("Hello world") && view.state.turn === "settled",
    "the first turn on the chosen model",
  );
  const entries = await openCodeJournal();
  const created = entries.findIndex((entry) => entry["action"] === "session-create");
  const prompted = entries.findIndex((entry) => entry["action"] === "prompt");
  expect(entries[created]).toMatchObject({ model: { id: "other-model", providerID: "other" } });
  expect(created).toBeLessThan(prompted);
  // The creation carried the model, so the prompt's own read finds it already in place.
  expect(await modelSwitches()).toEqual([]);
  expect(settled.state.model).toMatchObject({ provider: "other", id: "other-model" });
});

test("an unoffered pre-start model refuses the first prompt instead of sending it", async () => {
  const project = (await addProject(server)).project;
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "stream please",
    agent: {
      kind: "opencode",
      view: "chat",
      expectedModel: { provider: "stub", id: "missing-model" },
    },
    workspace: { type: "new-branch" },
  });
  const session = (await sessionsOf(api)).find((each) => each.id === task.primarySessionId);
  expect(session).toBeDefined();
  const refused = await untilChat(
    api,
    session!.id,
    (view) =>
      view.items.some(
        (item) =>
          item.kind === "error" &&
          item.text.includes("stream please") &&
          item.text.includes("did not offer this model"),
      ),
    "the refused initial prompt",
  );
  expect(refused.items.filter((item) => item.kind === "user-message")).toEqual([]);
  expect((await openCodeJournal()).filter((entry) => entry["action"] === "prompt")).toEqual([]);
  expect(await modelSwitches()).toEqual([]);
});

test("a refused OpenCode model switch keeps the queued words and sends no prompt", async () => {
  const { api, session } = await openCodeTask("stream please");
  await untilChat(
    api,
    session.id,
    (view) => view.state.turn === "settled" && (view.state.queue?.length ?? 0) === 0,
    "the first turn",
  );
  await api.chat.setModel({
    sessionId: session.id,
    model: { provider: "other", id: "other-model" },
  });
  await fakeScenario("model-switch-mode", "fail");
  await api.chat.send({ sessionId: session.id, text: "keep my words", mode: "prompt" });
  const kept = await untilChat(
    api,
    session.id,
    (view) =>
      view.items.some(
        (item) =>
          item.kind === "error" &&
          item.text.includes("This queued message was not sent: keep my words"),
      ),
    "the refused queued message",
  );
  expect(kept.state.model).toMatchObject({ provider: "stub", id: "stub-model" });
  expect(kept.state.selection).toEqual({
    model: { provider: "other", id: "other-model" },
    level: null,
  });
  const entries = await openCodeJournal();
  expect(entries.filter((entry) => entry["action"] === "prompt")).toEqual([
    expect.objectContaining({ text: "stream please" }),
  ]);
  expect(
    (await modelSwitches()).find(
      (entry) => isRecord(entry["model"]) && entry["model"]["id"] === "other-model",
    ),
  ).toMatchObject({
    model: { id: "other-model", providerID: "other" },
    mode: "fail",
  });
  // A 400 is the server answering and refusing, so it is not a doubtful write: the terminal opens
  // on the same native generation that answered.
  const opened = await api.sessions.setView({ id: session.id, view: "terminal", size: SIZE });
  expect(opened).toMatchObject({ view: "terminal", terminalId: expect.any(String) });
});

test("a terminal launch reservation holds queued chat until its terminal exits", async () => {
  const { api, session, projectId } = await openCodeTask();
  await untilChat(
    api,
    session.id,
    (view) => view.state.turn === "settled" && view.state.queue?.length === 0,
    "first turn",
  );
  const other = await openCodeTask("other initial", "main-worktree", projectId);
  await untilChat(
    other.api,
    other.session.id,
    (view) => view.state.turn === "settled" && view.state.queue?.length === 0,
    "other turn",
  );
  await api.chat.setModel({
    sessionId: session.id,
    model: { provider: "other", id: "other-model" },
  });
  const barrier = holdTerminal();
  const first = api.sessions.setView({ id: session.id, view: "terminal", size: SIZE });
  const secondClient = await server.rpc();
  try {
    expect(await barrier.entered.promise).toBe(session.id);
    const second = secondClient.sessions.setView({ id: session.id, view: "terminal", size: SIZE });
    await api.chat.send({ sessionId: session.id, text: "held queued turn", mode: "follow-up" });
    await expect(
      api.chat.send({ sessionId: session.id, text: "refused prompt", mode: "prompt" }),
    ).rejects.toMatchObject({ data: { reason: "turn-unconfirmed" } });
    await other.api.chat.send({ sessionId: other.session.id, text: "independent", mode: "prompt" });
    await untilChat(
      other.api,
      other.session.id,
      (view) =>
        view.items.some((item) => item.kind === "user-message" && item.text === "independent"),
      "independent session",
    );
    expect(await modelSwitches()).toEqual([]);
    expect(
      (await openCodeJournal()).filter(
        (entry) => entry["text"] === "held queued turn" || entry["text"] === "refused prompt",
      ),
    ).toEqual([]);
    barrier.release.resolve();
    const [opened, duplicate] = await Promise.all([first, second]);
    expect(duplicate.terminalId).toBe(opened.terminalId);
    await untilChat(
      api,
      session.id,
      (view) =>
        view.state.queue?.some(
          (entry) => entry.text === "held queued turn" && entry.status === "queued",
        ) === true,
      "queued behind live terminal",
    );
    expect(await modelSwitches()).toEqual([]);
    await expect
      .poll(
        async () =>
          (await agents.launches()).find(
            (launch) => launch.agent === "opencode" && launch.argv[0] !== "serve",
          ),
        { timeout: 10_000 },
      )
      .toBeDefined();
    const tui = (await agents.launches()).find(
      (launch) => launch.agent === "opencode" && launch.argv[0] !== "serve",
    )!;
    process.kill(tui.pid, "SIGTERM");
    await untilChat(
      api,
      session.id,
      (view) =>
        view.items.some(
          (item) => item.kind === "user-message" && item.text === "held queued turn",
        ) && view.state.turn === "settled",
      "queued turn after exit",
    );
    expect(
      (await openCodeJournal()).filter((entry) => entry["text"] === "held queued turn"),
    ).toHaveLength(1);
    expect(await modelSwitches()).toHaveLength(1);
  } finally {
    barrier.release.resolve();
  }
});

test("an initial prompt waits durably when a terminal wins during hydration", async () => {
  await fakeScenario("catalog-mode", "hold");
  const { api, session } = await openCodeTask("initial held text");
  await expect
    .poll(
      async () => (await openCodeJournal()).some((entry) => entry["action"] === "catalog-held"),
      { timeout: 10_000 },
    )
    .toBe(true);
  const serverLaunch = (await serveLaunches())[0]!;
  const barrier = holdTerminal();
  const opening = api.sessions.setView({ id: session.id, view: "terminal", size: SIZE });
  try {
    expect(await barrier.entered.promise).toBe(session.id);
    await fakeScenario("catalog-mode", "normal");
    process.kill(serverLaunch.pid, "SIGUSR2");
    await untilChat(
      api,
      session.id,
      (view) =>
        view.state.queue?.some(
          (entry) => entry.text === "initial held text" && entry.status === "queued",
        ) === true,
      "visible held initial prompt",
    );
    expect((await openCodeJournal()).filter((entry) => entry["action"] === "prompt")).toEqual([]);
    expect(await modelSwitches()).toEqual([]);
    barrier.release.resolve();
    const opened = await opening;
    expect(opened.terminalId).not.toBeNull();
    expect((await openCodeJournal()).filter((entry) => entry["action"] === "prompt")).toEqual([]);
    await expect
      .poll(
        async () =>
          (await agents.launches()).find(
            (launch) => launch.agent === "opencode" && launch.argv[0] !== "serve",
          ),
        { timeout: 10_000 },
      )
      .toBeDefined();
    const tui = (await agents.launches()).find(
      (launch) => launch.agent === "opencode" && launch.argv[0] !== "serve",
    )!;
    process.kill(tui.pid, "SIGTERM");
    await untilChat(
      api,
      session.id,
      (view) =>
        view.items.some(
          (item) => item.kind === "user-message" && item.text === "initial held text",
        ) && view.state.turn === "settled",
      "initial prompt after terminal exit",
    );
    expect(
      (await openCodeJournal()).filter((entry) => entry["text"] === "initial held text"),
    ).toHaveLength(1);
  } finally {
    barrier.release.resolve();
  }
});

test("a cancelled reserved terminal launch releases its queued chat turn once", async () => {
  const { api, session } = await openCodeTask();
  await untilChat(
    api,
    session.id,
    (view) => view.state.turn === "settled" && view.state.queue?.length === 0,
    "first turn",
  );
  await api.chat.setModel({
    sessionId: session.id,
    model: { provider: "other", id: "other-model" },
  });
  const barrier = holdTerminal();
  const opening = api.sessions.setView({ id: session.id, view: "terminal", size: SIZE });
  try {
    expect(await barrier.entered.promise).toBe(session.id);
    await api.chat.send({ sessionId: session.id, text: "after failed launch", mode: "follow-up" });
    expect(await modelSwitches()).toEqual([]);
    barrier.release.reject(new Error("injected terminal launch cancellation"));
    await expect(opening).rejects.toThrow("Internal server error");
    await untilChat(
      api,
      session.id,
      (view) =>
        view.items.some(
          (item) => item.kind === "user-message" && item.text === "after failed launch",
        ) && view.state.turn === "settled",
      "queued turn after launch failure",
    );
    expect(
      (await openCodeJournal()).filter((entry) => entry["text"] === "after failed launch"),
    ).toHaveLength(1);
    expect(await modelSwitches()).toHaveLength(1);
  } finally {
    barrier.release.resolve();
  }
});

test("a lost model switch response refuses a terminal and another prompt without retrying", async () => {
  const { api, session } = await openCodeTask();
  await untilChat(
    api,
    session.id,
    (view) => view.state.turn === "settled" && (view.state.queue?.length ?? 0) === 0,
    "the first turn",
  );
  await api.chat.setModel({
    sessionId: session.id,
    model: { provider: "other", id: "other-model" },
  });
  await fakeScenario("model-switch-mode", "lost");
  await api.chat.send({ sessionId: session.id, text: "keep these words", mode: "prompt" });
  await untilChat(
    api,
    session.id,
    (view) =>
      view.state.queue?.some(
        (entry) => entry.text === "keep these words" && entry.status === "undelivered",
      ) === true,
    "the unsent message",
  );
  await expect(
    api.sessions.setView({ id: session.id, view: "terminal", size: SIZE }),
  ).rejects.toMatchObject({ data: { message: expect.stringContaining("model switch") } });
  await expect(
    api.chat.send({ sessionId: session.id, text: "do not send", mode: "prompt" }),
  ).rejects.toMatchObject({ data: { reason: "turn-unconfirmed" } });
  expect((await modelSwitches()).filter((entry) => entry["mode"] === "lost")).toHaveLength(1);
  expect(
    (await openCodeJournal())
      .filter((entry) => entry["action"] === "prompt")
      .map((entry) => entry["text"]),
  ).toEqual(["stream please"]);
  await api.sessions.stop({ id: session.id });
  await api.sessions.setView({ id: session.id, view: "terminal", size: SIZE });
  expect(await api.sessions.restart({ id: session.id, size: SIZE })).toMatchObject({
    view: "terminal",
    state: "running",
  });
});

test("an ambiguous model-switch answer shows no provider text and is not retried", async () => {
  const { api, session } = await openCodeTask();
  await untilChat(
    api,
    session.id,
    (view) => view.state.turn === "settled" && (view.state.queue?.length ?? 0) === 0,
    "the first turn",
  );
  await api.chat.setModel({
    sessionId: session.id,
    model: { provider: "other", id: "other-model" },
  });
  await fakeScenario("model-switch-mode", "error");
  try {
    await api.chat.send({ sessionId: session.id, text: "keep these words", mode: "prompt" });
    const view = await untilChat(
      api,
      session.id,
      (snapshot) =>
        snapshot.state.queue?.some(
          (entry) => entry.text === "keep these words" && entry.status === "undelivered",
        ) === true,
      "the unsent message",
    );
    // The 500's own sentence never reaches a client item or the durable queue.
    expect(JSON.stringify(view.items)).not.toContain("provider secret");
    expect(JSON.stringify(view.state.queue)).not.toContain("provider secret");
    expect((await modelSwitches()).filter((entry) => entry["mode"] === "error")).toHaveLength(1);
    expect(
      (await openCodeJournal())
        .filter((entry) => entry["action"] === "prompt")
        .map((entry) => entry["text"]),
    ).toEqual(["stream please"]);
    await expect(
      api.sessions.setView({ id: session.id, view: "terminal", size: SIZE }),
    ).rejects.toMatchObject({ data: { message: expect.stringContaining("model switch") } });
  } finally {
    await fakeScenario("model-switch-mode", "ok");
  }
});

test("terminal opening is refused while a model switch is in flight", async () => {
  const { api, session, projectId } = await openCodeTask();
  await untilChat(
    api,
    session.id,
    (view) => view.state.turn === "settled" && (view.state.queue?.length ?? 0) === 0,
    "the first turn",
  );
  const other = await openCodeTask("other first", "main-worktree", projectId);
  await untilChat(
    other.api,
    other.session.id,
    (view) => view.state.turn === "settled" && (view.state.queue?.length ?? 0) === 0,
    "the other session's first turn",
  );
  await api.chat.setModel({
    sessionId: session.id,
    model: { provider: "other", id: "other-model" },
  });
  await fakeScenario("model-switch-mode", "hold");
  await api.chat.send({ sessionId: session.id, text: "held dispatch", mode: "prompt" });
  const deadline = Date.now() + 10_000;
  // oxlint-disable-next-line no-await-in-loop -- wait for the fake's observable request
  while (!(await modelSwitches()).some((entry) => entry["mode"] === "hold")) {
    if (Date.now() >= deadline) throw new Error("the model switch did not arrive");
    // oxlint-disable-next-line no-await-in-loop -- wait for the fake's observable request
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  try {
    await expect(
      api.sessions.setView({ id: session.id, view: "terminal", size: SIZE }),
    ).rejects.toMatchObject({ data: { message: expect.stringContaining("dispatching") } });
    const anotherClient = await server.rpc();
    await expect(
      anotherClient.sessions.setView({ id: session.id, view: "terminal", size: SIZE }),
    ).rejects.toMatchObject({ data: { message: expect.stringContaining("dispatching") } });
    await other.api.chat.send({
      sessionId: other.session.id,
      text: "other continues",
      mode: "prompt",
    });
    await untilChat(
      other.api,
      other.session.id,
      (view) =>
        view.items.some((item) => item.kind === "user-message" && item.text === "other continues"),
      "the other session's prompt",
    );
    expect((await openCodeJournal()).filter((entry) => entry["text"] === "held dispatch")).toEqual(
      [],
    );
  } finally {
    await fakeScenario("model-switch-mode", "ok");
  }
  await untilChat(
    api,
    session.id,
    (view) =>
      view.items.some((item) => item.kind === "user-message" && item.text === "held dispatch"),
    "the admitted prompt",
  );
});

test("unknown prompt delivery refuses a stopped terminal after server replacement", async () => {
  const { api, session } = await openCodeTask();
  await untilChat(
    api,
    session.id,
    (view) => view.state.turn === "settled" && (view.state.queue?.length ?? 0) === 0,
    "the first turn",
  );
  await api.sessions.stop({ id: session.id });
  const db = new DatabaseSync(join(server.dataDir, "corral.db"));
  try {
    db.prepare(
      `INSERT INTO chat_queue (id, session_id, text, selection, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("queued:unknown-opencode", session.id, "possibly admitted", null, "sending", 1);
  } finally {
    db.close();
  }
  await server.restart();
  const replacement = await server.rpc();
  await replacement.sessions.setView({ id: session.id, view: "terminal", size: SIZE });
  await expect(replacement.sessions.restart({ id: session.id, size: SIZE })).rejects.toMatchObject({
    data: { message: expect.stringContaining("delivery") },
  });
  expect(
    (await openCodeJournal()).filter((entry) => entry["text"] === "possibly admitted"),
  ).toEqual([]);
});

test("frontend exit during a lost model switch keeps the shared generation guarded", async () => {
  const { api, session, projectId } = await openCodeTask();
  await untilChat(
    api,
    session.id,
    (view) => view.state.turn === "settled" && (view.state.queue?.length ?? 0) === 0,
    "the first turn",
  );
  const other = await openCodeTask("keep server alive", "main-worktree", projectId);
  await untilChat(
    other.api,
    other.session.id,
    (view) => view.state.turn === "settled",
    "other session",
  );
  await api.chat.setModel({
    sessionId: session.id,
    model: { provider: "other", id: "other-model" },
  });
  await fakeScenario("model-switch-mode", "hold");
  await api.chat.send({ sessionId: session.id, text: "unsent after exit", mode: "prompt" });
  const deadline = Date.now() + 10_000;
  // oxlint-disable-next-line no-await-in-loop -- wait for the fake's observable request
  while (!(await modelSwitches()).some((entry) => entry["mode"] === "hold")) {
    if (Date.now() >= deadline) throw new Error("the model switch did not arrive");
    // oxlint-disable-next-line no-await-in-loop -- wait for the fake's observable request
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  try {
    await api.sessions.stop({ id: session.id });
    await api.sessions.restart({ id: session.id, size: SIZE });
    await fakeScenario("model-switch-mode", "lost");
    await untilChat(
      api,
      session.id,
      (view) =>
        view.state.queue?.some(
          (entry) => entry.text === "unsent after exit" && entry.status === "undelivered",
        ) === true,
      "the definitely unsent prompt",
    );
    await expect(
      api.sessions.setView({ id: session.id, view: "terminal", size: SIZE }),
    ).rejects.toMatchObject({ data: { message: expect.stringContaining("model switch") } });
    expect(
      (await openCodeJournal()).filter((entry) => entry["text"] === "unsent after exit"),
    ).toEqual([]);
  } finally {
    await fakeScenario("model-switch-mode", "ok");
  }
});

test("an unavailable OpenCode model refuses the next send instead of using the old model", async () => {
  const { api, session } = await openCodeTask("stream please");
  await untilChat(
    api,
    session.id,
    (view) => view.state.turn === "settled" && (view.state.queue?.length ?? 0) === 0,
    "the first turn",
  );
  await expect(
    api.chat.setModel({ sessionId: session.id, model: { provider: "stub", id: "missing-model" } }),
  ).rejects.toMatchObject({ code: "CHAT_MODEL_UNSUPPORTED" });
  await expect(
    api.chat.send({ sessionId: session.id, text: "draft stays here", mode: "prompt" }),
  ).rejects.toMatchObject({ code: "CHAT_MODEL_UNSUPPORTED" });
  const view = await untilChat(api, session.id, () => true, "the refused selection");
  expect(view.state.selection).toEqual({
    model: { provider: "stub", id: "missing-model" },
    level: null,
  });
  expect(view.state.model).toMatchObject({ provider: "stub", id: "stub-model" });
  expect(
    (await openCodeJournal()).filter(
      (entry) => entry["action"] === "prompt" && entry["text"] === "draft stays here",
    ),
  ).toEqual([]);
});

test("OpenCode ignores a stale durable completion while the current execution is running", async () => {
  const { api, session } = await openCodeTask("stale-events");
  const running = await untilChat(
    api,
    session.id,
    (view) => textOf(view).includes("still running"),
    "the current execution",
  );
  expect(running.state.turn).toBe("working");
  await api.chat.send({ sessionId: session.id, text: "must wait", mode: "follow-up" });
  const queued = await untilChat(
    api,
    session.id,
    (view) => view.state.followUp.includes("must wait"),
    "the queued message",
  );
  expect(queued.state.turn).toBe("working");
  expect((await openCodeJournal()).filter((entry) => entry["text"] === "must wait")).toEqual([]);
  await api.chat.abort({ sessionId: session.id });
});

test("OpenCode shutdown interruption does not release a queued prompt", async () => {
  const { api, session } = await openCodeTask("shutdown-interruption");
  await untilChat(
    api,
    session.id,
    (view) => textOf(view).includes("interrupted for shutdown") && view.state.turn === "aborted",
    "the shutdown interruption",
  );
  await api.chat.send({ sessionId: session.id, text: "wait for recovery", mode: "follow-up" });
  await untilChat(
    api,
    session.id,
    (view) => view.state.followUp.includes("wait for recovery"),
    "the paused prompt",
  );
  expect(
    (await openCodeJournal()).filter((entry) => entry["text"] === "wait for recovery"),
  ).toEqual([]);
});

test("an OpenCode chat task streams on the one server it starts, and opens its terminal as a client of it", async () => {
  const { api, session } = await openCodeTask();
  const capabilities = await api.chat.capabilities();
  expect(capabilities.drivers).toContainEqual({
    kind: "opencode",
    steer: true,
    followUp: true,
    approvals: true,
    modelSwitch: true,
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
  expect(prompts.map((entry) => entry["delivery"])).toEqual(["queue", "steer"]);

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
