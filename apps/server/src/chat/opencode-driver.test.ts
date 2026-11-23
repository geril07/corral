import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { isRecord } from "../../test/json.ts";
import { OpenCodeDriver, type OpenCodeDriverRequest } from "./opencode-driver.ts";
import { OpenCodeServers, type OpenCodeServerAddress } from "./opencode-server.ts";
import { ChatTimeline } from "./timeline.ts";

const agents = useFakeAgents();

interface Harness {
  driver: OpenCodeDriver;
  timeline: ChatTimeline;
  statuses: string[];
  exited: Promise<string | null>;
  server: OpenCodeServerAddress;
  servers: OpenCodeServers;
  root: string;
  stop(): Promise<void>;
}

function noop(): void {}

/** A pool on a fresh data directory, one driver on it, and what it reported. */
async function harness(
  options: {
    prompt?: string | null;
    sessionId?: string;
    expectedModel?: { provider: string | null; id: string };
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "corral-opencode-"));
  const servers = new OpenCodeServers({ dataDir: root, readyTimeoutMs: 10_000, exitGraceMs: 500 });
  const server = await servers.acquire("chat:test", {
    command: join(import.meta.dirname, "../..", "test", "fake-agents", "bin", "opencode"),
    cwd: root,
    env: processEnv(),
  });
  const timeline = new ChatTimeline(0);
  const statuses: string[] = [];
  let resolveExit: (reason: string | null) => void = noop;
  const exited = new Promise<string | null>((resolve) => (resolveExit = resolve));
  const sessionId = options.sessionId ?? "ses_driver0000000000000000000";
  const request: OpenCodeDriverRequest = {
    sessionId: "corral-session-1",
    timeline,
    command: "opencode",
    args: [],
    cwd: root,
    env: processEnv(),
    model: null,
    how: "start",
    prompt: options.prompt ?? null,
    ...(options.expectedModel === undefined ? {} : { expectedModel: options.expectedModel }),
    agentSessionId: sessionId,
    server,
    writer: { record: () => {}, release: () => {} },
    dialogTimeoutMs: 3000,
    readyTimeoutMs: 5000,
    exitGraceMs: 500,
    onStatus: (status) => statuses.push(status.state),
    onExit: (reason) => resolveExit(reason),
  };
  const driver = new OpenCodeDriver(request);
  driver.start();
  await until(() => statuses.length > 0, "the frontend to report its first state");
  return {
    driver,
    timeline,
    statuses,
    exited,
    server,
    servers,
    root,
    stop: async () => {
      await driver.stop();
      await servers.closeAll();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

async function journal(): Promise<Record<string, unknown>[]> {
  const text = await readFile(agents.openCodeLog, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as unknown)
    .filter(isRecord);
}

async function prompts(): Promise<Record<string, unknown>[]> {
  return (await journal()).filter((entry) => entry["action"] === "prompt");
}

async function modelSwitches(): Promise<Record<string, unknown>[]> {
  return (await journal()).filter((entry) => entry["action"] === "model-switch");
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polling the driver's observable state is the point
    if (await predicate()) return;
    // oxlint-disable-next-line no-await-in-loop -- see above
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function items(timeline: ChatTimeline) {
  return timeline.snapshot().items;
}

function textOf(timeline: ChatTimeline): string {
  return timeline
    .snapshot()
    .items.flatMap((item) => (item.kind === "assistant-message" ? [item.text] : []))
    .join("");
}

function usersOf(timeline: ChatTimeline) {
  return items(timeline).flatMap((item) => (item.kind === "user-message" ? [item] : []));
}

function answersOf(timeline: ChatTimeline) {
  return items(timeline).flatMap((item) => (item.kind === "assistant-message" ? [item] : []));
}

function noticeOf(timeline: ChatTimeline) {
  return items(timeline).find((item) => item.kind === "notice");
}

/** Writes one of the fake's persisted sessions into its data directory before the server starts. */
function seedHistory(sessionId: string, turns: number): void {
  const messages: Record<string, unknown>[] = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    const model =
      turn % 2 === 0
        ? { id: "other-model", providerID: "other" }
        : { id: "stub-model", providerID: "stub" };
    messages.push({
      id: `msg_seeduser${turn}`,
      type: "user",
      text: `question ${turn}`,
      time: { created: turn * 10 },
    });
    messages.push({
      id: `msg_seedassistant${turn}`,
      type: "assistant",
      agent: "build",
      model,
      time: { created: turn * 10 + 1 },
      content: [{ type: "text", text: `answer ${turn}` }],
    });
    messages.push({ id: `msg_seedidle${turn}`, type: "idle", outcome: "succeeded" });
  }
  writeFakeState(
    `${sessionId}.json`,
    JSON.stringify({
      id: sessionId,
      title: "seeded history",
      directory: "/tmp",
      messages,
      permissions: [],
      busy: false,
      outcome: "succeeded",
    }),
  );
}

/** The fake's paging behaviour for the next `/message` requests (see `messageMode` in it). */
function setMessageMode(mode: string): void {
  writeFakeState("message-mode", mode);
}

function writeFakeState(name: string, content: string): void {
  mkdirSync(agents.openCodeState, { recursive: true });
  writeFileSync(join(agents.openCodeState, name), content);
}

async function messagePages(): Promise<Record<string, unknown>[]> {
  return (await journal()).filter((entry) => entry["action"] === "message-list");
}

test("a turn streams text and a tool call into the timeline, with the diff the tool carried", async () => {
  const test1 = await harness();
  try {
    test1.driver.send("stream please", "prompt");
    await until(() => textOf(test1.timeline).includes("Hello world"), "the streamed text");
    await until(
      () =>
        items(test1.timeline).some((item) => item.kind === "tool-call" && item.status === "done"),
      "the finished tool call",
    );
    await until(() => test1.timeline.state.turn === "settled", "the settled turn");

    const tool = items(test1.timeline).find((item) => item.kind === "tool-call");
    expect(tool).toMatchObject({
      name: "edit",
      status: "done",
      output: "edit done",
      diff: {
        path: "src/app.ts",
        text: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new",
      },
    });
    expect(items(test1.timeline).find((item) => item.kind === "user-message")).toMatchObject({
      text: "stream please",
    });
    expect(test1.statuses).toContain("working");
    expect(test1.statuses).toContain("done");
  } finally {
    await test1.stop();
  }
});

test("an answer that arrives while a turn runs is a steer; a prompt then is refused, visibly", async () => {
  const test1 = await harness();
  try {
    test1.driver.send("hold", "prompt");
    await until(() => test1.timeline.state.turn === "working", "the working turn");
    test1.driver.send("more context", "steer");
    await until(async () => (await prompts()).length === 2, "the steer");
    expect((await prompts())[1]).toMatchObject({ text: "more context", delivery: "steer" });

    test1.driver.send("a second prompt", "prompt");
    await until(
      () =>
        items(test1.timeline).some(
          (item) => item.kind === "error" && item.text.includes("a turn is running"),
        ),
      "the refused prompt",
    );
    // Only the first prompt and the steer reached the server, and the refusal left no user item
    // for a message that never left the driver.
    expect(await prompts()).toHaveLength(2);
    expect(items(test1.timeline).filter((item) => item.kind === "user-message")).toHaveLength(2);

    await test1.driver.abort();
    await until(() => test1.timeline.state.turn === "aborted", "the interrupted turn");
    expect((await journal()).some((entry) => entry["action"] === "interrupt")).toBe(true);
  } finally {
    await test1.stop();
  }
});

test("a prepared selection switches the model before its prompt, and the catalog is the offer", async () => {
  const test1 = await harness();
  try {
    await until(() => test1.timeline.state.models.length > 0, "the model catalog");
    expect(test1.timeline.state.models).toEqual([
      { provider: "stub", id: "stub-model", name: "Stub Model" },
      { provider: "other", id: "other-model", name: "Other Model" },
    ]);

    const selection = { model: { provider: "other", id: "other-model" }, level: null };
    await test1.driver.prepareSelection(selection, { forDispatch: true });
    test1.driver.send("stream please", "prompt", selection);
    await until(() => test1.timeline.state.turn === "settled", "the turn");

    const entries = await journal();
    const switched = entries.findIndex((entry) => entry["action"] === "model-switch");
    const prompted = entries.findIndex(
      (entry) => entry["action"] === "prompt" && entry["text"] === "stream please",
    );
    expect(switched).toBeGreaterThanOrEqual(0);
    expect(entries[switched]).toMatchObject({
      sessionID: "ses_driver0000000000000000000",
      model: { id: "other-model", providerID: "other" },
    });
    expect(switched).toBeLessThan(prompted);
    expect(test1.timeline.state.model).toMatchObject({ provider: "other", id: "other-model" });
  } finally {
    await test1.stop();
  }
});

test("a selection with no offered model never reaches the session and leaves no user item", async () => {
  const test1 = await harness();
  try {
    await until(() => test1.timeline.state.models.length > 0, "the model catalog");
    const receipt = test1.driver.send("keep these words", "prompt", {
      model: { provider: "stub", id: "missing-model" },
      level: null,
    });
    const failure = await receipt.outcome;
    expect(failure?.name).toBe("ChatRefusalError");
    expect(failure?.message).toContain("did not offer this model");
    await until(
      () =>
        items(test1.timeline).some(
          (item) => item.kind === "error" && item.text.includes("did not switch the model"),
        ),
      "the visible refusal",
    );
    expect(usersOf(test1.timeline)).toHaveLength(0);
    expect(await prompts()).toEqual([]);
    expect(await modelSwitches()).toEqual([]);
  } finally {
    await test1.stop();
  }
});

test("a steer keeps the running turn's model and a selection chosen meanwhile does not switch it", async () => {
  const test1 = await harness();
  try {
    test1.driver.send("hold", "prompt");
    await until(() => test1.timeline.state.turn === "working", "the working turn");
    await test1.driver.prepareSelection(
      { model: { provider: "other", id: "other-model" }, level: null },
      { forDispatch: false },
    );
    test1.driver.send("more context", "steer");
    await until(async () => (await prompts()).length === 2, "the steer");

    expect(await modelSwitches()).toEqual([]);
    expect(test1.timeline.state.model).toMatchObject({ provider: "stub", id: "stub-model" });
    expect((await prompts())[1]).toMatchObject({ text: "more context", delivery: "steer" });
    await test1.driver.abort();
  } finally {
    await test1.stop();
  }
});

test("a new conversation is created on its chosen model before the first prompt", async () => {
  const test1 = await harness({
    prompt: "stream please",
    expectedModel: { provider: "other", id: "other-model" },
  });
  try {
    await until(() => test1.timeline.state.turn === "settled", "the first turn");
    const entries = await journal();
    const created = entries.findIndex((entry) => entry["action"] === "session-create");
    const prompted = entries.findIndex(
      (entry) => entry["action"] === "prompt" && entry["text"] === "stream please",
    );
    expect(entries[created]).toMatchObject({
      model: { id: "other-model", providerID: "other" },
    });
    expect(created).toBeLessThan(prompted);
    // The creation already carries the model; the prompt's own switch is the same ref, a no-op the
    // server documents, and it is what proves the turn will not run on another model.
    expect(await modelSwitches()).toEqual([
      expect.objectContaining({ model: { id: "other-model", providerID: "other" } }),
    ]);
    expect(test1.timeline.state.model).toMatchObject({ provider: "other", id: "other-model" });
  } finally {
    await test1.stop();
  }
});

test("a resumed conversation keeps the model its session recorded, and confirms it before the next prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "corral-opencode-"));
  const servers = new OpenCodeServers({ dataDir: root, readyTimeoutMs: 10_000 });
  const command = join(import.meta.dirname, "../..", "test", "fake-agents", "bin", "opencode");
  const server = await servers.acquire("chat:first", { command, cwd: root, env: processEnv() });
  const sessionId = "ses_resume000000000000000000";
  try {
    const first = new ChatTimeline(0);
    const started = driverOn(server, sessionId, {
      timeline: first,
      expectedModel: { provider: "other", id: "other-model" },
    });
    started.start();
    await until(() => first.state.model !== null, "the created session's model");
    expect(first.state.model).toMatchObject({ provider: "other", id: "other-model" });
    await started.stop();

    const resumedTimeline = new ChatTimeline(0);
    const resumed = driverOn(server, sessionId, { timeline: resumedTimeline, how: "resume" });
    resumed.start();
    await until(() => resumedTimeline.state.model !== null, "the resumed model");
    expect(resumedTimeline.state.model).toMatchObject({ provider: "other", id: "other-model" });
    const selection = { model: { provider: "other", id: "other-model" }, level: null };
    await resumed.prepareSelection(selection, { forDispatch: true });
    resumed.send("after resume", "prompt", selection);
    await until(() => resumedTimeline.state.turn === "settled", "the resumed turn");
    expect((await prompts())[0]).toMatchObject({ text: "after resume" });
    expect(await modelSwitches()).toEqual([
      expect.objectContaining({ model: { id: "other-model", providerID: "other" } }),
    ]);
    await resumed.stop();
  } finally {
    await servers.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("a permission request is answered from chat once, and reaches the server as its decision", async () => {
  const test1 = await harness();
  try {
    test1.driver.send("ask", "prompt");
    await until(
      () =>
        items(test1.timeline).some(
          (item) => item.kind === "user-request" && item.status === "pending",
        ),
      "the permission request",
    );
    const request = items(test1.timeline).find((item) => item.kind === "user-request");
    expect(request).toMatchObject({
      request: "select",
      title: "Allow editing src/app.ts?",
      body: "src/app.ts",
      options: [
        { value: "once", label: "Allow once" },
        expect.objectContaining({ value: "always" }),
        { value: "reject", label: "Reject" },
      ],
      status: "pending",
    });
    await until(() => (test1.statuses.at(-1) ?? "") === "blocked", "the blocked status");

    test1.driver.respond(request!.id, "once");
    await until(() => test1.timeline.state.turn === "settled", "the settled turn");
    expect(test1.timeline.item(request!.id)).toMatchObject({
      status: "answered",
      answer: "once",
    });
    const reply = (await journal()).find((entry) => entry["action"] === "permission-reply");
    expect(reply).toMatchObject({ decision: "once" });
    expect(test1.statuses).toContain("working");
  } finally {
    await test1.stop();
  }
});

test("an answer from the terminal frontend resolves the same request once, without a chat reply", async () => {
  const test1 = await harness();
  try {
    test1.driver.send("ask", "prompt");
    await until(
      () =>
        items(test1.timeline).some(
          (item) => item.kind === "user-request" && item.status === "pending",
        ),
      "the permission request",
    );
    const request = items(test1.timeline).find((item) => item.kind === "user-request");
    const requestId = request!.id.replace(/^permission:/, "");
    // The other frontend answers through the same API; the driver only sees the event.
    const response = await fetch(
      `${test1.server.url}/api/session/ses_driver0000000000000000000/permission/${requestId}/reply`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${test1.server.password}`).toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ decision: "always" }),
      },
    );
    expect(response.status).toBe(204);
    await until(() => {
      const item = test1.timeline.item(request!.id);
      return item?.kind === "user-request" && item.status === "answered";
    }, "the answered request");
    await until(() => test1.timeline.state.turn === "settled", "the settled turn");
    // Chat sent no reply of its own: the journal has exactly the terminal's decision.
    const replies = (await journal()).filter((entry) => entry["action"] === "permission-reply");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ decision: "always" });
  } finally {
    await test1.stop();
  }
});

test(
  "a stopped frontend rebuilds the same transcript from the server's messages",
  { timeout: 20_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "corral-opencode-"));
    const servers = new OpenCodeServers({ dataDir: root, readyTimeoutMs: 10_000 });
    const command = join(import.meta.dirname, "../..", "test", "fake-agents", "bin", "opencode");
    const server = await servers.acquire("chat:first", { command, cwd: root, env: processEnv() });
    const first = new ChatTimeline(0);
    const driver = new OpenCodeDriver({
      sessionId: "corral-session-1",
      timeline: first,
      command: "opencode",
      args: [],
      cwd: root,
      env: processEnv(),
      model: null,
      how: "start",
      prompt: null,
      agentSessionId: "ses_rebuild000000000000000000",
      server,
      writer: { record: () => {}, release: () => {} },
      dialogTimeoutMs: 3000,
      readyTimeoutMs: 5000,
      exitGraceMs: 500,
      onStatus: () => {},
      onExit: () => {},
    });
    try {
      driver.start();
      await until(
        async () => (await journal()).some((entry) => entry["action"] === "session-create"),
        "the session the driver creates",
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      driver.send("stream", "prompt");
      await until(() => first.state.turn === "settled", "the first turn");
      await driver.stop();

      const second = new ChatTimeline(0);
      const rebuilt = new OpenCodeDriver({
        sessionId: "corral-session-1",
        timeline: second,
        command: "opencode",
        args: [],
        cwd: root,
        env: processEnv(),
        model: null,
        how: "start",
        prompt: null,
        agentSessionId: "ses_rebuild000000000000000000",
        server,
        writer: { record: () => {}, release: () => {} },
        dialogTimeoutMs: 3000,
        readyTimeoutMs: 5000,
        exitGraceMs: 500,
        onStatus: () => {},
        onExit: () => {},
      });
      rebuilt.start();
      await until(() => second.state.turn === "settled", "the rebuilt transcript");
      // The rebuilt text is exact: no duplicated replay, no lost delta at a boundary.
      expect(textOf(second)).toBe("Hello world");
      expect(
        items(second).find((item) => item.kind === "tool-call" && item.status === "done"),
      ).toMatchObject({ name: "edit", diff: { path: "src/app.ts" } });
      expect(items(second).find((item) => item.kind === "user-message")).toMatchObject({
        text: "stream",
      });
      // The rebuild did not duplicate what the stream had already produced.
      expect(items(second).filter((item) => item.kind === "assistant-message")).toHaveLength(1);
      await rebuilt.stop();
    } finally {
      await servers.closeAll();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("a server that dies is reported as an exit with the reason, not as silence", async () => {
  const test1 = await harness();
  try {
    await until(
      async () => (await journal()).some((entry) => entry["action"] === "session-create"),
      "the session",
    );
    const pid = (await journal()).find((entry) => entry["action"] === "listen")?.["pid"];
    expect(typeof pid).toBe("number");
    if (typeof pid !== "number") throw new Error("the fake server did not journal its pid");
    process.kill(pid, "SIGKILL");
    const reason = await test1.exited;
    expect(reason).toEqual(expect.stringContaining("opencode"));
  } finally {
    await test1.stop();
  }
});

/** A driver on an existing pool server, for the tests that start a second frontend. */
function driverOn(
  server: { url: string; password: string },
  sessionId: string,
  options: {
    prompt?: string | null;
    timeline: ChatTimeline;
    statuses?: string[];
    expectedModel?: { provider: string | null; id: string };
    how?: "start" | "resume";
  },
): OpenCodeDriver {
  return new OpenCodeDriver({
    sessionId: "corral-session-2",
    timeline: options.timeline,
    command: "opencode",
    args: [],
    cwd: "/tmp",
    env: processEnv(),
    model: null,
    how: options.how ?? "start",
    prompt: options.prompt ?? null,
    ...(options.expectedModel === undefined ? {} : { expectedModel: options.expectedModel }),
    agentSessionId: sessionId,
    server,
    writer: { record: () => {}, release: () => {} },
    dialogTimeoutMs: 3000,
    readyTimeoutMs: 5000,
    exitGraceMs: 500,
    onStatus: (status) => options.statuses?.push(status.state),
    onExit: () => {},
  });
}

test("a second frontend on a session that already has a user message sends no prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "corral-opencode-"));
  const servers = new OpenCodeServers({ dataDir: root, readyTimeoutMs: 10_000 });
  const command = join(import.meta.dirname, "../..", "test", "fake-agents", "bin", "opencode");
  const server = await servers.acquire("chat:first", { command, cwd: root, env: processEnv() });
  const sessionId = "ses_prompt0000000000000000000";
  const first = new ChatTimeline(0);
  const driver = driverOn(server, sessionId, { prompt: "stream please", timeline: first });
  try {
    driver.start();
    await until(() => first.state.turn === "settled", "the first turn");
    expect(await prompts()).toHaveLength(1);
    await driver.stop();

    const second = new ChatTimeline(0);
    const restarted = driverOn(server, sessionId, { prompt: "stream please", timeline: second });
    restarted.start();
    await until(() => second.state.turn === "settled", "the rebuilt turn");
    expect(await prompts()).toHaveLength(1);
    expect(second.snapshot().items.filter((item) => item.kind === "user-message")).toHaveLength(1);
    await restarted.stop();
  } finally {
    await servers.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("a delta that repeats the previous tail is text, not a replay", async () => {
  const test1 = await harness();
  try {
    test1.driver.send("split", "prompt");
    await until(() => test1.timeline.state.turn === "settled", "the split turn");
    expect(textOf(test1.timeline)).toBe("coffee");

    test1.driver.send("haha", "prompt");
    await until(
      () => textOf(test1.timeline).endsWith("haha") && test1.timeline.state.turn === "settled",
      "the repeated-tail turn",
    );
    expect(textOf(test1.timeline)).toBe("coffeehaha");
  } finally {
    await test1.stop();
  }
});

test("a prompt the other frontend types appears as its user message, with the id a rebuild uses", async () => {
  const test1 = await harness();
  try {
    const messageId = "msg_external0000000000000000";
    const response = await fetch(
      `${test1.server.url}/api/session/ses_driver0000000000000000000/prompt`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`opencode:${test1.server.password}`).toString("base64")}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ id: messageId, text: "from the terminal" }),
      },
    );
    expect(response.ok).toBe(true);

    // The live stream must carry the user item, not only the tool call and the answer.
    await until(() => {
      const item = test1.timeline.item(`user:${messageId}`);
      return item?.kind === "user-message" && item.text === "from the terminal";
    }, "the user message from the other client");
    await until(() => test1.timeline.state.turn === "settled", "the external turn");

    // A rebuild reads the same id from `/message`, so it replaces the live item rather than
    // adding a second one.
    await test1.driver.stop();
    const rebuilt = new ChatTimeline(0);
    const second = driverOn(test1.server, "ses_driver0000000000000000000", { timeline: rebuilt });
    second.start();
    await until(() => rebuilt.state.turn === "settled", "the rebuilt transcript");
    expect(
      rebuilt
        .snapshot()
        .items.filter((item) => item.kind === "user-message")
        .map((item) => [item.id, item.text]),
    ).toEqual([[`user:${messageId}`, "from the terminal"]]);
    await second.stop();
  } finally {
    await test1.stop();
  }
});

test(
  "a long history is read page by page, in order, with every answer's model",
  { timeout: 20_000 },
  async () => {
    const sessionId = "ses_history000000000000000000";
    seedHistory(sessionId, 150);
    const test1 = await harness({ sessionId });
    try {
      await until(
        () => answersOf(test1.timeline).length === 150 && test1.timeline.state.turn === "settled",
        "the whole seeded history",
      );
      expect(usersOf(test1.timeline).map((item) => item.text)).toEqual(
        Array.from({ length: 150 }, (_, index) => `question ${index + 1}`),
      );
      const answers = answersOf(test1.timeline);
      expect(answers.map((item) => item.text)).toEqual(
        Array.from({ length: 150 }, (_, index) => `answer ${index + 1}`),
      );
      // The model is the one each answer names in the transcript, not the session's latest one.
      expect(answers[0]).toMatchObject({
        text: "answer 1",
        model: { provider: "stub", id: "stub-model" },
      });
      expect(answers[1]).toMatchObject({
        text: "answer 2",
        model: { provider: "other", id: "other-model" },
      });
      expect(answers.at(-1)).toMatchObject({
        text: "answer 150",
        model: { provider: "other", id: "other-model" },
      });
      expect(test1.timeline.state.model).toEqual({
        provider: "other",
        id: "other-model",
        name: "other-model",
      });
      const ids = items(test1.timeline).map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);

      const pages = await messagePages();
      expect(pages.length).toBeGreaterThan(1);
      expect(pages[0]).toMatchObject({
        mode: "paged",
        limit: 200,
        order: "desc",
        cursor: null,
      });
      expect(pages[1]?.["cursor"]).toEqual(expect.any(String));
      // Only the first page names an order; a cursor already carries it.
      expect(pages[1]?.["order"]).toBeNull();
      expect(noticeOf(test1.timeline)).toBeUndefined();
    } finally {
      await test1.stop();
    }
  },
);

test(
  "a cursor that repeats ends the walk and shows that earlier messages are missing",
  { timeout: 20_000 },
  async () => {
    const sessionId = "ses_repeat0000000000000000000";
    seedHistory(sessionId, 150);
    setMessageMode("repeat-cursor");
    const test1 = await harness({ sessionId });
    try {
      await until(() => noticeOf(test1.timeline) !== undefined, "the truncation notice");
      expect(noticeOf(test1.timeline)?.text).toContain("Earlier messages were not loaded");
      // What was read is the newest page: the current turn survives, older turns do not.
      expect(usersOf(test1.timeline).at(-1)?.text).toBe("question 150");
      expect(answersOf(test1.timeline).at(-1)?.text).toBe("answer 150");
      expect(answersOf(test1.timeline).length).toBeLessThan(150);
      expect(await messagePages()).toHaveLength(2);
      expect(test1.timeline.state.turn).toBe("settled");
    } finally {
      await test1.stop();
    }
  },
);

test(
  "the page cap stops an endless cursor and marks the transcript as partial",
  { timeout: 20_000 },
  async () => {
    const sessionId = "ses_endless000000000000000000";
    seedHistory(sessionId, 0);
    setMessageMode("endless");
    const test1 = await harness({ sessionId });
    try {
      await until(() => noticeOf(test1.timeline) !== undefined, "the cap notice");
      expect(noticeOf(test1.timeline)?.text).toContain("Earlier messages were not loaded");
      expect(answersOf(test1.timeline)).toHaveLength(100);
      expect(await messagePages()).toHaveLength(100);
    } finally {
      await test1.stop();
    }
  },
);

test("a short history with no next cursor is loaded as it is", async () => {
  const sessionId = "ses_short00000000000000000000";
  seedHistory(sessionId, 2);
  setMessageMode("no-next");
  const test1 = await harness({ sessionId });
  try {
    await until(
      () => answersOf(test1.timeline).length === 2 && test1.timeline.state.turn === "settled",
      "the short history",
    );
    expect(usersOf(test1.timeline).map((item) => item.text)).toEqual(["question 1", "question 2"]);
    expect(answersOf(test1.timeline).map((item) => item.text)).toEqual(["answer 1", "answer 2"]);
    expect(answersOf(test1.timeline)[1]).toMatchObject({
      model: { provider: "other", id: "other-model" },
    });
    expect(noticeOf(test1.timeline)).toBeUndefined();
    expect(await messagePages()).toHaveLength(1);
  } finally {
    await test1.stop();
  }
});

test(
  "a server that ignores limit still returns the whole history in one answer",
  { timeout: 20_000 },
  async () => {
    const sessionId = "ses_ignore0000000000000000000";
    seedHistory(sessionId, 150);
    setMessageMode("ignore-limit");
    const test1 = await harness({ sessionId });
    try {
      await until(
        () => answersOf(test1.timeline).length === 150 && test1.timeline.state.turn === "settled",
        "the whole history",
      );
      expect(usersOf(test1.timeline)).toHaveLength(150);
      expect(usersOf(test1.timeline).at(-1)?.text).toBe("question 150");
      expect(answersOf(test1.timeline).at(-1)?.text).toBe("answer 150");
      expect(answersOf(test1.timeline)[1]).toMatchObject({
        model: { provider: "other", id: "other-model" },
      });
      expect(noticeOf(test1.timeline)).toBeUndefined();
      expect(await messagePages()).toHaveLength(1);
    } finally {
      await test1.stop();
    }
  },
);

test("live deltas after a rebuilt history append once, after the hydrated answers", async () => {
  const sessionId = "ses_live00000000000000000000";
  seedHistory(sessionId, 2);
  const test1 = await harness({ sessionId });
  try {
    await until(
      () => answersOf(test1.timeline).length === 2 && test1.timeline.state.turn === "settled",
      "the hydrated history",
    );
    test1.driver.send("split", "prompt");
    await until(
      () =>
        answersOf(test1.timeline).at(-1)?.text === "coffee" &&
        test1.timeline.state.turn === "settled",
      "the live answer",
    );
    expect(answersOf(test1.timeline).map((item) => item.text)).toEqual([
      "answer 1",
      "answer 2",
      "coffee",
    ]);
    expect(usersOf(test1.timeline).at(-1)?.text).toBe("split");
    const ids = items(test1.timeline).map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  } finally {
    await test1.stop();
  }
});

test("one session's stream never carries another session's text", async () => {
  const root = await mkdtemp(join(tmpdir(), "corral-opencode-"));
  const servers = new OpenCodeServers({ dataDir: root, readyTimeoutMs: 10_000 });
  const command = join(import.meta.dirname, "../..", "test", "fake-agents", "bin", "opencode");
  const server = await servers.acquire("chat:shared", { command, cwd: root, env: processEnv() });
  const timelineA = new ChatTimeline(0);
  const timelineB = new ChatTimeline(0);
  const a = driverOn(server, "ses_cross00000000000000000000", { timeline: timelineA });
  const b = driverOn(server, "ses_cross11111111111111111111", { timeline: timelineB });
  try {
    a.start();
    b.start();
    await until(
      async () =>
        (await journal()).filter((entry) => entry["action"] === "session-create").length === 2,
      "both sessions created",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    a.send("alpha", "prompt");
    b.send("beta", "prompt");
    await until(
      () => textOf(timelineA).includes("echo: alpha") && textOf(timelineB).includes("echo: beta"),
      "both turns",
    );
    expect(textOf(timelineA)).not.toContain("beta");
    expect(textOf(timelineB)).not.toContain("alpha");
  } finally {
    await a.stop();
    await b.stop();
    await servers.closeAll();
    await rm(root, { recursive: true, force: true });
  }
});
