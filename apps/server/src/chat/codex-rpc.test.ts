import type { ChatSnapshot } from "@corral/protocol/chat";
import { Task } from "@corral/protocol/rpc";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { resetCodexVersionCache } from "../agents/codex-version.ts";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { addProject } from "../../test/project-fixture.ts";
import { frontendArgs, sessionsOf } from "../../test/session-helpers.ts";
import { isRecord } from "../../test/json.ts";
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

test("a configured Codex chat starts independently of model discovery and exposes the native list", async () => {
  const { api, session } = await codexTask("chat");
  const state = await untilChat(
    api,
    session.id,
    (view) => view.state.models.some((model) => model.id === "stub-model"),
    "the Codex model list",
  );
  expect(state.state.models).toContainEqual({
    id: "stub-model",
    provider: "stub",
    name: "Stub Model",
    reasoningLevels: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
  });
});

test("Codex first prompt sends the captured model and offered effort", async () => {
  const project = (await addProject(server)).project;
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "selected first turn",
    agent: {
      kind: "codex",
      view: "chat",
      model: "stub-two",
      expectedModel: { provider: "stub", id: "stub-two" },
      thinking: { model: { provider: "stub", id: "stub-two" }, level: "high" },
    },
    workspace: { type: "new-branch" },
  });
  const session = (await sessionsOf(api)).find((each) => each.id === task.primarySessionId)!;
  await untilChat(api, session.id, (view) => view.state.turn === "settled", "the first turn");
  const record = await threadRecord(server.dataDir, session.id);
  expect(record?.["turns"]).toMatchObject([
    { requestedModel: "stub-two", requestedEffort: "high" },
  ]);
});

test("a first Codex model-only prompt uses its native model default", async () => {
  const project = (await addProject(server)).project;
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "first model only",
    agent: {
      kind: "codex",
      view: "chat",
      model: "stub-three",
      expectedModel: { provider: "stub", id: "stub-three" },
    },
    workspace: { type: "new-branch" },
  });
  const session = (await sessionsOf(api)).find((entry) => entry.id === task.primarySessionId)!;
  await untilChat(api, session.id, (view) => view.state.turn === "settled", "the first turn");
  await expect
    .poll(async () => (await threadRecord(server.dataDir, session.id))?.["turns"])
    .toMatchObject([{ requestedModel: "stub-three", requestedEffort: "medium" }]);
});

test("a first Codex model-only prompt is retained when native effort is unknown", async () => {
  vi.stubEnv("FAKE_CODEX_UNKNOWN_EFFORT", "1");
  const project = (await addProject(server)).project;
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "first with unknown effort",
    agent: {
      kind: "codex",
      view: "chat",
      model: "stub-three",
      expectedModel: { provider: "stub", id: "stub-three" },
    },
    workspace: { type: "new-branch" },
  });
  const session = (await sessionsOf(api)).find((entry) => entry.id === task.primarySessionId)!;
  await untilChat(
    api,
    session.id,
    (view) =>
      view.items.some(
        (item) =>
          item.kind === "error" &&
          item.text.includes("first with unknown effort") &&
          item.text.includes("could not confirm the configured reasoning default"),
      ),
    "the retained first prompt",
  );
  expect((await threadRecord(server.dataDir, session.id))?.["turns"]).toEqual([]);
  expect(task.prompt).toBe("first with unknown effort");
});

test("Codex distinguishes an unspecified effort from an explicitly offered off", async () => {
  const ordinary = await codexTask("chat", "unspecified effort");
  await untilChat(
    ordinary.api,
    ordinary.session.id,
    (view) => view.state.turn === "settled",
    "the unconfigured turn",
  );
  const ordinaryTurns = (await threadRecord(server.dataDir, ordinary.session.id))?.["turns"];
  expect(ordinaryTurns).toHaveLength(1);
  expect(ordinaryTurns).toEqual([
    expect.not.objectContaining({ requestedEffort: expect.anything() }),
  ]);
  const task = await ordinary.api.tasks.create({
    projectId: ordinary.projectId,
    prompt: "explicit off",
    agent: {
      kind: "codex",
      view: "chat",
      model: "stub-three",
      expectedModel: { provider: "stub", id: "stub-three" },
      thinking: { model: { provider: "stub", id: "stub-three" }, level: "off" },
    },
    workspace: { type: "new-branch" },
  });
  const session = (await sessionsOf(ordinary.api)).find(
    (entry) => entry.id === task.primarySessionId,
  )!;
  await untilChat(
    ordinary.api,
    session.id,
    (view) => view.state.turn === "settled",
    "the off turn",
  );
  expect((await threadRecord(server.dataDir, session.id))?.["turns"]).toMatchObject([
    { requestedModel: "stub-three", requestedEffort: "off" },
  ]);
});

test("Codex steers the running turn and keeps a queued model and effort after a later choice", async () => {
  const { api, session } = await codexTask("chat", "SLOW FOREIGN_COMPLETION first turn");
  await untilChat(api, session.id, (view) => view.state.turn === "working", "the first turn");
  await api.chat.setModel({
    sessionId: session.id,
    model: { provider: "stub", id: "stub-two" },
    level: "high",
  });
  await api.chat.send({ sessionId: session.id, text: "steer A", mode: "steer" });
  await api.chat.send({ sessionId: session.id, text: "queued B", mode: "follow-up" });
  expect((await timelineOf(api, session.id)).state.queue).toContainEqual(
    expect.objectContaining({ text: "queued B", status: "queued" }),
  );
  await api.chat.setModel({
    sessionId: session.id,
    model: { provider: "stub", id: "stub-three" },
    level: "medium",
  });
  await untilChat(
    api,
    session.id,
    (view) =>
      view.items.some((item) => item.kind === "user-message" && item.text === "queued B") &&
      view.state.turn === "settled" &&
      (view.state.queue?.length ?? 0) === 0,
    "the queued turn",
  );
  const turns = (await threadRecord(server.dataDir, session.id))?.["turns"];
  expect(turns).toMatchObject([
    { items: expect.arrayContaining([expect.objectContaining({ type: "userMessage" })]) },
    { requestedModel: "stub-two", requestedEffort: "high" },
  ]);
});

test("a queued Codex model-only choice uses its own default after a later explicit choice", async () => {
  const project = (await addProject(server)).project;
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "SLOW explicit A",
    agent: {
      kind: "codex",
      view: "chat",
      model: "stub-model",
      expectedModel: { provider: "stub", id: "stub-model" },
      thinking: { model: { provider: "stub", id: "stub-model" }, level: "high" },
    },
    workspace: { type: "new-branch" },
  });
  const session = (await sessionsOf(api)).find((entry) => entry.id === task.primarySessionId)!;
  await untilChat(
    api,
    session.id,
    (view) => view.state.turn === "working",
    "the explicit first turn",
  );
  await api.chat.setModel({ sessionId: session.id, model: { provider: "stub", id: "stub-two" } });
  await api.chat.send({ sessionId: session.id, text: "queued model default B", mode: "follow-up" });
  await api.chat.setModel({
    sessionId: session.id,
    model: { provider: "stub", id: "stub-three" },
    level: "off",
  });
  await expect
    .poll(async () => (await threadRecord(server.dataDir, session.id))?.["turns"], {
      timeout: 10_000,
    })
    .toMatchObject([
      { requestedModel: "stub-model", requestedEffort: "high" },
      { requestedModel: "stub-two", requestedEffort: "low" },
    ]);
});

test("Codex holds a queued choice after completion until the delayed turn receipt is correlated", async () => {
  const { api, session } = await codexTask("chat", "SLOW DELAY_RECEIPT");
  await untilChat(api, session.id, (view) => view.state.turn === "working", "the active turn");
  await api.chat.setModel({
    sessionId: session.id,
    model: { provider: "stub", id: "stub-two" },
    level: "high",
  });
  await api.chat.send({ sessionId: session.id, text: "after receipt", mode: "follow-up" });
  const held = await untilChat(
    api,
    session.id,
    (view) =>
      view.state.turn === "settled" &&
      view.state.queue?.some(
        (entry) => entry.text === "after receipt" && entry.status === "queued",
      ) === true,
    "the completed turn with its receipt still pending",
  );
  expect(
    held.items.some((item) => item.kind === "user-message" && item.text === "after receipt"),
  ).toBe(false);
  await untilChat(
    api,
    session.id,
    (view) =>
      view.items.some((item) => item.kind === "user-message" && item.text === "after receipt") &&
      view.state.turn === "settled",
    "the queued turn after receipt",
  );
  expect((await threadRecord(server.dataDir, session.id))?.["turns"]).toMatchObject([
    {},
    { requestedModel: "stub-two", requestedEffort: "high" },
  ]);
});

test("Codex refuses an unoffered effort before dispatch instead of passing it to the provider", async () => {
  const { api, session } = await codexTask("chat", "first valid turn");
  await untilChat(api, session.id, (view) => view.state.turn === "settled", "the first turn");
  await expect(
    api.chat.setModel({
      sessionId: session.id,
      model: { provider: "stub", id: "stub-two" },
      level: "off",
    }),
  ).rejects.toMatchObject({ code: "CHAT_REASONING_UNSUPPORTED" });
  await expect(
    api.models.thinking({
      scope: { kind: "codex", profileId: null },
      model: { provider: "stub", id: "stub-two" },
    }),
  ).resolves.toBeNull();
  const turns = (await threadRecord(server.dataDir, session.id))?.["turns"];
  expect(turns).toHaveLength(1);
});

test("a Codex model-only switch uses its model default for consecutive turns", async () => {
  const { api, session } = await codexTask("chat", "first native turn");
  await untilChat(api, session.id, (view) => view.state.turn === "settled", "the first turn");
  await api.chat.setModel({ sessionId: session.id, model: { provider: "stub", id: "stub-two" } });
  await api.chat.send({ sessionId: session.id, text: "keep this draft", mode: "prompt" });
  await untilChat(
    api,
    session.id,
    (view) =>
      view.items.some((item) => item.kind === "user-message" && item.text === "keep this draft"),
    "the selected turn",
  );
  await expect
    .poll(async () => (await threadRecord(server.dataDir, session.id))?.["turns"])
    .toMatchObject([{}, { requestedModel: "stub-two", requestedEffort: "low" }]);
  await untilChat(
    api,
    session.id,
    (view) => view.state.turn === "settled" && view.state.queue?.length === 0,
    "the settled selected turn",
  );
  await api.chat.send({ sessionId: session.id, text: "another default turn", mode: "prompt" });
  await expect
    .poll(async () => (await threadRecord(server.dataDir, session.id))?.["turns"])
    .toMatchObject([{}, {}, { requestedModel: "stub-two", requestedEffort: "low" }]);
});

test("a configured Codex effort takes precedence over the model's different default", async () => {
  vi.stubEnv("FAKE_CODEX_EFFORT", "high");
  const { api, session } = await codexTask("chat", "configured first turn");
  await untilChat(api, session.id, (view) => view.state.turn === "settled", "the first turn");
  await api.chat.setModel({ sessionId: session.id, model: { provider: "stub", id: "stub-two" } });
  await api.chat.send({ sessionId: session.id, text: "configured high", mode: "prompt" });
  await expect
    .poll(async () => (await threadRecord(server.dataDir, session.id))?.["turns"])
    .toMatchObject([{}, { requestedModel: "stub-two", requestedEffort: "high" }]);
  expect(
    await api.models.thinking({
      scope: { kind: "codex", profileId: null },
      model: { provider: "stub", id: "stub-two" },
    }),
  ).toBeNull();
});

test("separate Codex profiles apply their own configured default without sharing memory", async () => {
  vi.stubEnv("CODEX_EFFORT_A", "low");
  vi.stubEnv("CODEX_EFFORT_B", "high");
  await mkdir(server.configDir, { recursive: true });
  await writeFile(
    join(server.configDir, "config.toml"),
    `
[profiles.one]
name = "One"
agent = "codex"
env = [{ targetName = "FAKE_CODEX_EFFORT", fromEnv = "CODEX_EFFORT_A" }]
[profiles.two]
name = "Two"
agent = "codex"
env = [{ targetName = "FAKE_CODEX_EFFORT", fromEnv = "CODEX_EFFORT_B" }]
`,
  );
  const { api, task } = await codexTaskWithOptions();
  await within(
    (async () => {
      for await (const state of await api.config.watch()) if (state.profiles.length === 2) return;
      throw new Error("config watch ended");
    })(),
    "Codex profiles",
  );
  for (const [profileId, effort] of [
    ["one", "low"],
    ["two", "high"],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop -- sessions and their independent snapshots are asserted in order
    const session = await api.sessions.start({
      taskId: task.id,
      kind: "codex",
      view: "chat",
      profileId,
      size: SIZE,
    });
    // oxlint-disable-next-line no-await-in-loop -- the selected session must be ready before its turn
    await untilChat(
      api,
      session.id,
      (view) => view.state.models.some((model) => model.id === "stub-two"),
      "the profile model list",
    );
    // oxlint-disable-next-line no-await-in-loop -- each profile selects independently
    await api.chat.setModel({ sessionId: session.id, model: { provider: "stub", id: "stub-two" } });
    // oxlint-disable-next-line no-await-in-loop -- dispatch this profile before starting the next
    await api.chat.send({ sessionId: session.id, text: `profile ${profileId}`, mode: "prompt" });
    // oxlint-disable-next-line no-await-in-loop -- the fake agent journals after accepting the turn
    await expect
      .poll(async () => (await threadRecord(server.dataDir, session.id))?.["turns"])
      .toMatchObject([{ requestedModel: "stub-two", requestedEffort: effort }]);
    // oxlint-disable-next-line no-await-in-loop -- defaults must not become explicit memory
    const remembered = await api.models.thinking({
      scope: { kind: "codex", profileId },
      model: { provider: "stub", id: "stub-two" },
    });
    expect(remembered).toBeNull();
  }
});

test("an unoffered configured Codex default is not silently replaced by the model default", async () => {
  vi.stubEnv("FAKE_CODEX_EFFORT", "high");
  const { api, session } = await codexTask("chat", "configured incompatible first");
  await untilChat(api, session.id, (view) => view.state.turn === "settled", "the first turn");
  await api.chat.setModel({ sessionId: session.id, model: { provider: "stub", id: "stub-three" } });
  await expect(
    api.chat.send({ sessionId: session.id, text: "keep configured draft", mode: "prompt" }),
  ).rejects.toMatchObject({ code: "CHAT_UNAVAILABLE" });
  expect((await threadRecord(server.dataDir, session.id))?.["turns"]).toHaveLength(1);
});

test("a Codex model with no reasoning levels works with an unset native effort", async () => {
  const { api, session } = await codexTask("chat", "first without explicit effort");
  await untilChat(api, session.id, (view) => view.state.turn === "settled", "the first turn");
  await api.chat.setModel({ sessionId: session.id, model: { provider: "stub", id: "stub-plain" } });
  await api.chat.send({ sessionId: session.id, text: "plain model", mode: "prompt" });
  await expect
    .poll(async () => (await threadRecord(server.dataDir, session.id))?.["turns"])
    .toMatchObject([{}, { requestedModel: "stub-plain" }]);
  const turns = (await threadRecord(server.dataDir, session.id))?.["turns"];
  expect(turns).toEqual([
    expect.anything(),
    expect.not.objectContaining({ requestedEffort: expect.anything() }),
  ]);
});

test("a Codex model without levels refuses an inherited explicit effort it cannot reset", async () => {
  const { api, session } = await codexTask("chat", "first before explicit effort");
  await untilChat(api, session.id, (view) => view.state.turn === "settled", "the first turn");
  await api.chat.setModel({
    sessionId: session.id,
    model: { provider: "stub", id: "stub-two" },
    level: "high",
  });
  await api.chat.send({ sessionId: session.id, text: "explicit high", mode: "prompt" });
  await untilChat(
    api,
    session.id,
    (view) =>
      view.items.some((item) => item.kind === "user-message" && item.text === "explicit high") &&
      view.state.turn === "settled" &&
      view.state.queue?.length === 0,
    "the explicit turn",
  );
  await api.chat.setModel({ sessionId: session.id, model: { provider: "stub", id: "stub-plain" } });
  await expect(
    api.chat.send({ sessionId: session.id, text: "keep plain draft", mode: "prompt" }),
  ).rejects.toMatchObject({ code: "CHAT_UNAVAILABLE" });
});

test("an unoffered Codex launch effort cannot overwrite an existing preference", async () => {
  const { api, session, projectId } = await codexTask("chat", "valid memory setup");
  await untilChat(api, session.id, (view) => view.state.turn === "settled", "the first turn");
  const model = { provider: "stub", id: "stub-two" };
  const scope = { kind: "codex" as const, profileId: null };
  await api.models.rememberThinking({ scope, context: { projectId }, model, level: "high" });
  const task = await api.tasks.create({
    projectId,
    prompt: "do not send invalid effort",
    agent: {
      kind: "codex",
      view: "chat",
      model: model.id,
      expectedModel: model,
      thinking: { model, level: "not-offered" },
    },
    workspace: { type: "new-branch" },
  });
  const failed = (await sessionsOf(api)).find((entry) => entry.id === task.primarySessionId);
  expect(failed).toMatchObject({ state: "stopped" });
  expect(task.prompt).toBe("do not send invalid effort");
  expect(await api.models.thinking({ scope, model })).toBe("high");
});

test("a captured remembered Codex choice does not overwrite a newer client's preference", async () => {
  const { api, session, projectId } = await codexTask("chat", "memory seed");
  await untilChat(api, session.id, (view) => view.state.turn === "settled", "the seed turn");
  const other = await server.rpc();
  const scope = { kind: "codex" as const, profileId: null };
  const model = { provider: "stub", id: "stub-two" };
  const memoryInput = { scope, context: { projectId }, model };
  await api.models.rememberThinking({ ...memoryInput, level: "high" });
  await other.models.rememberThinking({ ...memoryInput, level: "low" });
  const task = await api.tasks.create({
    projectId,
    prompt: "captured high",
    agent: {
      kind: "codex",
      view: "chat",
      model: model.id,
      expectedModel: model,
      thinking: { model, level: "high", remembered: true },
    },
    workspace: { type: "new-branch" },
  });
  const selected = (await sessionsOf(api)).find((entry) => entry.id === task.primarySessionId)!;
  await untilChat(api, selected.id, (view) => view.state.turn === "settled", "the captured turn");
  await expect
    .poll(async () => (await threadRecord(server.dataDir, selected.id))?.["turns"])
    .toMatchObject([{ requestedModel: "stub-two", requestedEffort: "high" }]);
  expect(await other.models.thinking({ scope, model })).toBe("low");
});

test("Codex retains a prompt after native turn refusal", async () => {
  const { api, session } = await codexTask("chat", "first accepted");
  await untilChat(api, session.id, (view) => view.state.turn === "settled", "the first turn");
  await api.chat.setModel({
    sessionId: session.id,
    model: { provider: "stub", id: "stub-two" },
    level: "high",
  });
  await api.chat.send({ sessionId: session.id, text: "REFUSE_SEND retained", mode: "prompt" });
  const view = await untilChat(
    api,
    session.id,
    (snapshot) =>
      snapshot.state.queue?.some(
        (entry) => entry.text === "REFUSE_SEND retained" && entry.status === "undelivered",
      ) === true,
    "the refused prompt",
  );
  expect(view.state.queue).toContainEqual(
    expect.objectContaining({ text: "REFUSE_SEND retained", status: "undelivered" }),
  );
  expect((await threadRecord(server.dataDir, session.id))?.["turns"]).toHaveLength(1);
});

test("Codex keeps a queued prompt undelivered when fresh model discovery fails", async () => {
  const { api, session } = await codexTask("chat", "SLOW before discovery failure");
  await untilChat(api, session.id, (view) => view.state.turn === "working", "the running turn");
  await api.chat.setModel({
    sessionId: session.id,
    model: { provider: "stub", id: "stub-two" },
    level: "high",
  });
  await api.chat.send({
    sessionId: session.id,
    text: "queued during catalog failure",
    mode: "follow-up",
  });
  await mkdir(agents.codexHome, { recursive: true });
  await writeFile(join(agents.codexHome, "catalog-error"), "");
  try {
    const view = await untilChat(
      api,
      session.id,
      (snapshot) =>
        snapshot.state.queue?.some(
          (entry) =>
            entry.text === "queued during catalog failure" && entry.status === "undelivered",
        ) === true,
      "the retained queued prompt",
    );
    expect(view.state.queue).toContainEqual(
      expect.objectContaining({ text: "queued during catalog failure", status: "undelivered" }),
    );
    expect((await threadRecord(server.dataDir, session.id))?.["turns"]).toHaveLength(1);
  } finally {
    await rm(join(agents.codexHome, "catalog-error"), { force: true });
  }
});

test("Codex restores a captured next-turn choice after restart without replaying the first prompt", async () => {
  const { api, session } = await codexTask("chat", "first before restart");
  await untilChat(api, session.id, (view) => view.state.turn === "settled", "the first turn");
  await api.chat.setModel({
    sessionId: session.id,
    model: { provider: "stub", id: "stub-three" },
    level: "medium",
  });
  await server.restart();
  const resumed = await server.rpc();
  await vi.waitFor(
    async () => {
      const view = await timelineOf(resumed, session.id);
      expect(view.state.models.some((model) => model.id === "stub-three")).toBe(true);
    },
    { timeout: 10_000 },
  );
  await untilChat(
    resumed,
    session.id,
    (view) =>
      view.state.selection?.model.id === "stub-three" &&
      view.state.selection.level === "medium" &&
      view.state.models.some((model) => model.id === "stub-three"),
    "the restored choice",
  );
  await resumed.chat.send({ sessionId: session.id, text: "after restart", mode: "prompt" });
  await untilChat(
    resumed,
    session.id,
    (view) =>
      view.items.some((item) => item.kind === "user-message" && item.text === "after restart") &&
      view.state.turn === "settled",
    "the resumed turn",
  );
  await expect
    .poll(async () => (await threadRecord(server.dataDir, session.id))?.["turns"])
    .toMatchObject([{}, { requestedModel: "stub-three", requestedEffort: "medium" }]);
});

test("a Codex model-only choice resumes with its native default and does not replay old turns", async () => {
  const { api, session } = await codexTask("chat", "first before default resume");
  await untilChat(api, session.id, (view) => view.state.turn === "settled", "the first turn");
  await api.chat.setModel({ sessionId: session.id, model: { provider: "stub", id: "stub-two" } });
  await api.chat.send({ sessionId: session.id, text: "default before restart", mode: "prompt" });
  await expect
    .poll(async () => (await threadRecord(server.dataDir, session.id))?.["turns"])
    .toMatchObject([{}, { requestedModel: "stub-two", requestedEffort: "low" }]);
  await untilChat(
    api,
    session.id,
    (view) => view.state.turn === "settled" && view.state.queue?.length === 0,
    "the settled default turn",
  );
  await server.restart();
  const resumed = await server.rpc();
  await vi.waitFor(
    async () => {
      const view = await timelineOf(resumed, session.id);
      expect(view.state.selection).toEqual({
        model: { provider: "stub", id: "stub-two" },
        level: null,
      });
      expect(view.state.models.some((model) => model.id === "stub-two")).toBe(true);
    },
    { timeout: 10_000 },
  );
  await resumed.chat.send({ sessionId: session.id, text: "default after restart", mode: "prompt" });
  await expect
    .poll(async () => (await threadRecord(server.dataDir, session.id))?.["turns"])
    .toMatchObject([
      {},
      { requestedModel: "stub-two", requestedEffort: "low" },
      { requestedModel: "stub-two", requestedEffort: "low" },
    ]);
});

test("Codex configured launch works without discovery while an explicit selection is refused with its prompt retained", async () => {
  await mkdir(agents.codexHome, { recursive: true });
  await writeFile(join(agents.codexHome, "catalog-error"), "");
  try {
    const ordinary = await codexTask("chat", "ordinary offline catalog");
    const offline = await untilChat(
      ordinary.api,
      ordinary.session.id,
      (view) =>
        view.state.modelsStatus === "error" &&
        view.state.turn === "settled" &&
        textOf(view).includes("the stub answer"),
      "the configured turn",
    );
    expect(offline.state.model?.id).toBe("stub-model");
    expect(offline.state.models).toHaveLength(1);
    await expect(
      ordinary.api.chat.refreshModels({ sessionId: ordinary.session.id }),
    ).rejects.toMatchObject({
      code: "CHAT_UNAVAILABLE",
      data: { message: "Codex could not load its model list." },
    });
    expect((await timelineOf(ordinary.api, ordinary.session.id)).state.models).toEqual(
      offline.state.models,
    );
    await ordinary.api.chat.send({
      sessionId: ordinary.session.id,
      text: "configured while offline",
      mode: "prompt",
    });
    await untilChat(
      ordinary.api,
      ordinary.session.id,
      (view) =>
        view.items.some(
          (item) => item.kind === "user-message" && item.text === "configured while offline",
        ),
      "the configured follow-up",
    );
    const task = await ordinary.api.tasks.create({
      projectId: ordinary.projectId,
      prompt: "keep this selected prompt",
      agent: {
        kind: "codex",
        view: "chat",
        model: "stub-two",
        expectedModel: { provider: "stub", id: "stub-two" },
        thinking: { model: { provider: "stub", id: "stub-two" }, level: "high" },
      },
      workspace: { type: "new-branch" },
    });
    const session = (await sessionsOf(ordinary.api)).find(
      (entry) => entry.id === task.primarySessionId,
    )!;
    expect(session).toMatchObject({
      state: "stopped",
      launchError: "The selected Codex thinking level was not confirmed.",
    });
    expect(await threadRecord(server.dataDir, session.id)).toBeUndefined();
    await rm(join(agents.codexHome, "catalog-error"), { force: true });
    await ordinary.api.chat.refreshModels({ sessionId: ordinary.session.id });
    const recovered = await timelineOf(ordinary.api, ordinary.session.id);
    expect(recovered.state.modelsStatus).toBe("ready");
    expect(recovered.state.models.some((model) => model.id === "stub-two")).toBe(true);
    await writeFile(join(agents.codexHome, "catalog-error"), "");
    await expect(
      ordinary.api.chat.refreshModels({ sessionId: ordinary.session.id }),
    ).rejects.toMatchObject({ code: "CHAT_UNAVAILABLE" });
    const failedAgain = await timelineOf(ordinary.api, ordinary.session.id);
    expect(failedAgain.state.modelsStatus).toBe("error");
    expect(failedAgain.state.models).toEqual(recovered.state.models);
    expect(failedAgain.state.model).toEqual(recovered.state.model);
    await expect(
      ordinary.api.models.thinking({
        scope: { kind: "codex", profileId: null },
        model: { provider: "stub", id: "stub-two" },
      }),
    ).resolves.toBeNull();
    await server.restart();
    const resumed = await server.rpc();
    const updates = await resumed.tasks.watch();
    const tasks = Task.array().parse((await updates.next()).value);
    expect(tasks.find((entry) => entry.id === task.id)?.prompt).toBe("keep this selected prompt");
    await updates.return?.();
  } finally {
    await rm(join(agents.codexHome, "catalog-error"), { force: true });
  }
});

test(
  "a Codex chat task streams, stores the assigned thread id, and opens its terminal as a second client of one app-server",
  { timeout: 30_000 },
  async () => {
    const { api, session } = await codexTask("chat");
    const capabilities = await api.chat.capabilities();
    expect(capabilities.drivers).toContainEqual({
      kind: "codex",
      steer: true,
      followUp: true,
      approvals: true,
      modelSwitch: true,
      modelRefresh: true,
      reasoningLevels: true,
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

test("successive Codex prompts wait for their matching turn completion", async () => {
  const { api, session } = await codexTask("chat", "initial");
  for (const text of ["first follow-on", "second follow-on"]) {
    // oxlint-disable-next-line no-await-in-loop -- each send must follow the prior native turn
    await untilChat(
      api,
      session.id,
      (view) => view.state.turn === "settled" && (view.state.queue?.length ?? 0) === 0,
      "the prior completed turn",
    );
    // oxlint-disable-next-line no-await-in-loop -- ordered user prompts
    await api.chat.send({ sessionId: session.id, text, mode: "prompt" });
    // oxlint-disable-next-line no-await-in-loop -- wait until this send is visible before the next
    await untilChat(
      api,
      session.id,
      (view) => view.items.some((item) => item.kind === "user-message" && item.text === text),
      text,
    );
  }
  const complete = await untilChat(
    api,
    session.id,
    (view) => view.state.turn === "settled" && (view.state.queue?.length ?? 0) === 0,
    "the second completed turn",
  );
  expect(
    complete.items.filter((item) => item.kind === "user-message").map((item) => item.text),
  ).toEqual(["initial", "first follow-on", "second follow-on"]);
});

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

    // The terminal stays available with a plain launch, without a Corral app-server.
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
    const record: unknown = JSON.parse(
      await readFile(join(server.dataDir, "chat", `codex-server-${session.id}.json`), "utf8"),
    );
    const recordedPid = isRecord(record) && typeof record["pid"] === "number" ? record["pid"] : 0;
    process.kill(recordedPid, "SIGKILL");
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
    const terminal = (await agents.launches()).findLast(
      (entry) => entry.agent === "codex" && entry.rolloutId !== undefined,
    );
    expect(terminal?.rolloutId).not.toBe(chatId);
  },
);

test(
  "a both-live switch keeps the live thread even before its rollout exists",
  { timeout: 30_000 },
  async () => {
    // A real server writes the rollout on the first turn; until then the id is only in the live
    // app-server's memory, and the terminal must resume it rather than start a second conversation.
    vi.stubEnv("FAKE_CODEX_NO_ROLLOUT", "1");
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
    expect(frontendArgs(last.argv)).toEqual(["resume", chatId!]);
  },
);

test(
  "a thread with no rollout cannot be resumed once its app-server is gone, so a restart starts a new conversation",
  { timeout: 30_000 },
  async () => {
    vi.stubEnv("FAKE_CODEX_NO_ROLLOUT", "1");
    vi.stubEnv("FAKE_CODEX_ROLLOUT", "never");
    const { api, session } = await codexTask("chat");
    await untilChat(api, session.id, (view) => view.items.length > 0, "the chat frontend");
    expect((await sessionsOf(api)).find((each) => each.id === session.id)?.agentSessionId).toMatch(
      /^thr-/,
    );

    // Stop the session (the app-server goes with it) and restart it in the terminal view: there is
    // no live server and no rollout, so the recorded id is forgotten and a new conversation starts
    // with the task's prompt.
    await api.sessions.stop({ id: session.id });
    await api.sessions.setView({ id: session.id, view: "terminal", size: SIZE });
    await api.sessions.restart({ id: session.id, size: SIZE });
    const launches = await until(
      async () =>
        (await agents.launches()).filter(
          (launch) => launch.agent === "codex" && launch.argv.includes("--remote"),
        ),
      1,
      "the restarted terminal leg",
    );
    const last = launches.at(-1)!;
    expect(frontendArgs(last.argv)).toEqual(["--", "stream please"]);
  },
);

test(
  "a chat-only session refuses an unrenderable request after its terminal leg exits",
  { timeout: 40_000 },
  async () => {
    // Terminal first, then chat: the chat driver launches while the terminal is live, which is the
    // case a launch-time flag would freeze. The terminal then quits; the chat keeps the session.
    const { api, session } = await codexTask("terminal");
    const terminal = await server.attach(session.terminalId!);
    await terminal.waitForScreen("fake codex ready");
    const switched = await api.sessions.setView({ id: session.id, view: "chat", size: SIZE });
    expect(switched.view).toBe("chat");
    await untilChat(api, session.id, (view) => view.items.length > 0, "the chat frontend");
    terminal.type("exit\n");
    await terminal.waitForClose();
    await expect
      .poll(async () => (await sessionsOf(api)).find((each) => each.id === session.id)?.state, {
        timeout: 10_000,
      })
      .toBe("running");

    const decisionsBefore = (await decisionsOf(server.dataDir, session.id)).length;
    await api.chat.send({ sessionId: session.id, text: "ASK please", mode: "prompt" });
    const settled = await untilChat(
      api,
      session.id,
      (view) =>
        view.items.some(
          (item) => item.kind === "error" && item.text.includes("extra permissions"),
        ) && view.state.turn !== "working",
      "the chat-only refusal after the terminal exited",
    );
    const refusal = settled.items.find(
      (item) => item.kind === "error" && item.text.includes("extra permissions"),
    );
    expect(refusal?.kind === "error" ? refusal.text : undefined).toContain("terminal view");
    // The refusal reached the server, so the turn is not waiting for an answer nobody will give.
    await expect
      .poll(async () => (await decisionsOf(server.dataDir, session.id)).length, { timeout: 10_000 })
      .toBeGreaterThan(decisionsBefore);
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
    .map((line): unknown => JSON.parse(line))
    .filter(isRecord)
    .map((record) => record["thread"])
    .filter(isRecord);
  return records.at(-1);
}

/** The fake app-server's decisions journal for a session, one entry per answer it received. */
async function decisionsOf(dataDir: string, sessionId: string): Promise<string[]> {
  const text = await readFile(
    join(dataDir, "codex", `${sessionId}.sock.journal.decisions`),
    "utf8",
  ).catch(() => "");
  return text.split("\n").filter((line) => line !== "");
}
