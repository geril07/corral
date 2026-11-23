import type {
  ChatEvent,
  ChatItem,
  ChatSessionState,
  ChatStreamMessage,
} from "@corral/protocol/chat";
import { ConfigState } from "@corral/protocol/config";
import { Task } from "@corral/protocol/rpc";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test, vi } from "vite-plus/test";
import { z } from "zod";
import { floorPath } from "./sequence-floor.ts";
import { recordWriter, writerPath } from "./writer-claim.ts";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { addProject, addTask } from "../../test/project-fixture.ts";
import { useServer, within } from "../../test/server-fixture.ts";
import { launchesOf, processExists, sessionsOf } from "../../test/session-helpers.ts";

const server = useServer({
  // These files start real servers, app-servers and PTYs; the ready and test budgets must survive
  // the documented parallel load rather than turn a slow host into a false failure.
  chat: { dialogTimeoutMs: 600, readyTimeoutMs: 4000, exitGraceMs: 400, writerWaitMs: 2000 },
});
// Polls in this file allow up to 10 s, so the default 5 s test budget contradicts them under load.
vi.setConfig({ testTimeout: 20_000 });
const agents = useFakeAgents();
const SIZE = { cols: 80, rows: 24 };

type Api = Awaited<ReturnType<typeof server.rpc>>;

/** The task's state in the watched feed, which is what the sidebar, board and header read. */
async function taskStateOf(api: Api, taskId: string): Promise<Task["state"] | undefined> {
  const updates = await api.tasks.watch();
  const first = await updates.next();
  await updates.return?.();
  return z
    .array(Task)
    .parse(first.value)
    .find((task) => task.id === taskId)?.state;
}

/** A project and a task whose primary session is a chat session with `prompt`. */
async function chatTask(prompt = "Add a note to notes.txt", projectName = "app") {
  const { project } = await addProject(server, projectName);
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt,
    agent: { kind: "pi", view: "chat" },
    workspace: { type: "main-worktree" },
  });
  const session = (await sessionsOf(api)).find(
    (candidate) => candidate.id === task.primarySessionId,
  );
  expect(session, "the task's primary chat session").toBeDefined();
  return { api, task, session: session! };
}

/** A rejection value from a client stream, as text that says something. */
function describe(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function emptyState(): ChatSessionState {
  return {
    turn: "idle",
    turnStartedAt: null,
    turnEndedAt: null,
    steering: [],
    followUp: [],
    model: null,
    models: [],
    reasoning: null,
    reasoningLevels: [],
    selection: null,
    selectionIssue: null,
    context: null,
  };
}

/**
 * Follows one `chat.watch` with the same rules the client store applies (B0), so the assertions
 * are about what a client sees: snapshot, then contiguous events, deltas appended to items.
 */
class Follow {
  sequence = -1;
  state: ChatSessionState = emptyState();
  items: ChatItem[] = [];
  readonly messages: ChatStreamMessage[] = [];
  done = false;
  failure: unknown;
  readonly #source: Promise<AsyncIterable<ChatStreamMessage>>;
  readonly #waiters = new Set<() => void>();
  #iterator: AsyncIterator<ChatStreamMessage> | undefined;

  constructor(source: Promise<AsyncIterable<ChatStreamMessage>>) {
    this.#source = source;
    void this.#run();
  }

  async #run(): Promise<void> {
    try {
      const iterable = await this.#source;
      this.#iterator = iterable[Symbol.asyncIterator]();
      while (true) {
        // oxlint-disable-next-line no-await-in-loop -- one message at a time is the stream
        const next = await this.#iterator.next();
        if (next.done === true) break;
        this.messages.push(next.value);
        this.#apply(next.value);
        this.#notify();
      }
    } catch (error) {
      this.failure = error;
    } finally {
      this.done = true;
      this.#notify();
    }
  }

  item(id: string): ChatItem | undefined {
    return this.items.find((item) => item.id === id);
  }

  itemOfKind<K extends ChatItem["kind"]>(kind: K): Extract<ChatItem, { kind: K }> | undefined {
    return this.items.find((item): item is Extract<ChatItem, { kind: K }> => item.kind === kind);
  }

  /** Resolves once `predicate` holds, or rejects when the stream ends or the deadline passes. */
  until(predicate: (follow: Follow) => boolean, description: string): Promise<void> {
    return within(
      new Promise<void>((resolve, reject) => {
        const check = () => {
          if (this.done && this.failure !== undefined) {
            this.#waiters.delete(check);
            reject(
              this.failure instanceof Error ? this.failure : new Error(describe(this.failure)),
            );
            return;
          }
          if (predicate(this)) {
            this.#waiters.delete(check);
            resolve();
          }
        };
        this.#waiters.add(check);
        check();
      }),
      description,
    );
  }

  async close(): Promise<void> {
    const iterator = this.#iterator ?? (await this.#source)[Symbol.asyncIterator]();
    await iterator.return?.(undefined);
  }

  #notify(): void {
    for (const waiter of Array.from(this.#waiters)) waiter();
  }

  #apply(message: ChatStreamMessage): void {
    if (message.type === "snapshot") {
      this.sequence = message.snapshot.sequence;
      this.state = message.snapshot.state;
      this.items = [...message.snapshot.items];
      return;
    }
    if (message.sequence !== this.sequence + 1)
      throw new Error(`chat sequence hole: expected ${this.sequence + 1}, got ${message.sequence}`);
    this.sequence = message.sequence;
    this.#event(message.event);
  }

  #event(event: ChatEvent): void {
    switch (event.type) {
      case "item": {
        const index = this.items.findIndex((item) => item.id === event.item.id);
        if (index === -1) this.items = [...this.items, event.item];
        else this.items = this.items.with(index, event.item);
        return;
      }
      case "delta": {
        this.items = this.items.map((item) =>
          item.id === event.itemId &&
          (item.kind === "assistant-message" || item.kind === "reasoning")
            ? { ...item, text: item.text + event.text }
            : item,
        );
        return;
      }
      case "state":
        this.state = event.state;
        return;
    }
  }
}

function follow(api: Api, sessionId: string, options: { after?: number } = {}): Follow {
  return new Follow(api.chat.watch({ sessionId, ...options }));
}

/** Pulls the first message of a watch that the server may refuse. */
async function firstMessage(
  watch: Promise<AsyncIterable<ChatStreamMessage>>,
): Promise<ChatStreamMessage> {
  const iterator = (await watch)[Symbol.asyncIterator]();
  const first = await iterator.next();
  await iterator.return?.(undefined);
  if (first.done === true) throw new Error("the chat stream ended before its first message");
  return first.value;
}

async function journalOf(agentSessionId: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(
    join(agents.piRpcHome, `${agentSessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`),
    "utf8",
  );
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("the fake pi journal is not an array");
  return parsed.filter(
    (entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry),
  );
}

function userMessages(journal: Record<string, unknown>[]): unknown[] {
  return journal
    .filter((message) => message["role"] === "user")
    .map((message) => message["content"]);
}

/** The status a session had when it last changed, from `sessions.watch`. */
async function waitForStatus(
  api: Api,
  sessionId: string,
  state: "working" | "blocked" | "done" | "error" | "idle",
): Promise<void> {
  await expect
    .poll(
      async () =>
        (await sessionsOf(api)).find((session) => session.id === sessionId)?.status?.state,
      { timeout: 10_000, message: `the ${state} status of ${sessionId}` },
    )
    .toBe(state);
}

test("a task created in chat view starts pi in RPC mode with its prompt, and the whole turn streams", async () => {
  // Slow enough that the watch below is attached before the answer streams.
  vi.stubEnv("FAKE_PI_RPC", "slow");
  vi.stubEnv("FAKE_PI_RPC_DELAY_MS", "300");
  const { api, task, session } = await chatTask();

  expect(session).toMatchObject({ view: "chat", kind: "pi", state: "running", terminalId: null });
  expect(await api.terminals.list()).toEqual([]);
  expect(await api.chat.capabilities()).toEqual({
    drivers: [
      {
        kind: "claude",
        steer: true,
        followUp: true,
        approvals: true,
        modelSwitch: true,
        reasoningLevels: true,
        terminalView: "handoff-only",
      },
      {
        kind: "codex",
        steer: true,
        followUp: true,
        approvals: true,
        modelSwitch: true,
        reasoningLevels: true,
        terminalView: "both-live",
      },
      {
        kind: "pi",
        steer: true,
        followUp: true,
        approvals: true,
        modelSwitch: true,
        reasoningLevels: true,
        terminalView: "handoff-only",
      },
      {
        kind: "opencode",
        steer: true,
        followUp: true,
        approvals: true,
        modelSwitch: true,
        reasoningLevels: false,
        terminalView: "both-live",
      },
    ],
  });

  await expect
    .poll(async () => (await agents.launches()).length, { timeout: 10_000, message: "the launch" })
    .toBe(1);
  const [launch] = await agents.launches();
  expect(launch).toMatchObject({
    agent: "pi",
    cwd: task.workspacePath,
    env: { CORRAL_SESSION_ID: session.id, CORRAL_TASK_ID: task.id },
  });
  expect(launch!.argv).toEqual(["--mode", "rpc", "--session-id", session.agentSessionId]);

  const chat = follow(api, session.id);
  try {
    await chat.until(
      (view) => view.itemOfKind("user-request")?.status === "pending",
      "the dialog request",
    );
    // The prompt was handed over by the `prompt` command, once, as the first user message.
    expect(chat.itemOfKind("user-message")).toMatchObject({ text: "Add a note to notes.txt" });
    expect(chat.itemOfKind("assistant-message")).toMatchObject({
      text: "Here is the answer.",
      streaming: true,
    });
    expect(chat.itemOfKind("tool-call")).toMatchObject({
      name: "edit",
      status: "running",
    });
    expect(chat.itemOfKind("user-request")).toMatchObject({
      request: "confirm",
      title: "Apply the edit?",
      body: "notes.txt will change.",
      status: "pending",
      expiresAt: expect.any(Number),
    });
    await waitForStatus(api, session.id, "blocked");

    const request = chat.itemOfKind("user-request")!;
    await api.chat.respond({ sessionId: session.id, requestId: request.id, value: true });
    await chat.until((view) => view.state.turn === "settled", "the settled turn");

    expect(chat.item(request.id)).toMatchObject({ status: "answered", answer: true });
    expect(chat.itemOfKind("tool-call")).toMatchObject({
      status: "done",
      output: "Successfully replaced 1 block(s) in notes.txt.",
      diff: {
        path: "notes.txt",
        text: "--- notes.txt\n+++ notes.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n",
      },
    });
    expect(chat.itemOfKind("assistant-message")).toMatchObject({ streaming: false });
    // Streaming really was incremental: deltas arrived before the settled state.
    expect(
      chat.messages.some((message) => message.type === "event" && message.event.type === "delta"),
    ).toBe(true);
    await waitForStatus(api, session.id, "done");

    const journal = await journalOf(session.agentSessionId!);
    expect(userMessages(journal)).toEqual(["Add a note to notes.txt"]);
  } finally {
    await chat.close();
  }
});

test("a restart resumes the same pi session: the chat is rebuilt from history and the prompt is not sent again", async () => {
  const { api, session } = await chatTask("Remember this");
  const first = follow(api, session.id);
  try {
    await first.until((view) => view.itemOfKind("user-request") !== undefined, "the dialog");
    await api.chat.respond({
      sessionId: session.id,
      requestId: first.itemOfKind("user-request")!.id,
      value: true,
    });
    await first.until((view) => view.state.turn === "settled", "the settled turn");
  } finally {
    await first.close();
  }

  await server.restart();
  const restarted = await server.rpc();
  await expect
    .poll(async () => (await agents.launches()).length, { timeout: 10_000, message: "the resume" })
    .toBe(2);
  const [restored] = await sessionsOf(restarted);
  expect(restored).toMatchObject({
    id: session.id,
    view: "chat",
    state: "running",
    terminalId: null,
    agentSessionId: session.agentSessionId,
  });
  const launches = await agents.launches();
  expect(launches.map((launch) => launch.argv)).toEqual([
    ["--mode", "rpc", "--session-id", session.agentSessionId],
    ["--mode", "rpc", "--session-id", session.agentSessionId],
  ]);

  const chat = follow(restarted, session.id);
  try {
    await chat.until(
      (view) => view.itemOfKind("tool-call")?.status === "done",
      "the rebuilt history",
    );
    expect(chat.itemOfKind("user-message")).toMatchObject({ text: "Remember this" });
    expect(chat.itemOfKind("assistant-message")).toMatchObject({
      text: "Here is the answer.",
      streaming: false,
    });
    expect(chat.itemOfKind("tool-call")).toMatchObject({
      status: "done",
      diff: { path: "notes.txt" },
    });
    expect(await journalOf(session.agentSessionId!)).toHaveLength(3);
    expect(userMessages(await journalOf(session.agentSessionId!))).toEqual(["Remember this"]);
  } finally {
    await chat.close();
  }
});

test("the server stops waiting for a dialog on its own deadline and pi can continue", async () => {
  const { api, session } = await chatTask();
  const chat = follow(api, session.id);
  try {
    await chat.until((view) => view.itemOfKind("user-request") !== undefined, "the dialog");
    await waitForStatus(api, session.id, "blocked");
    const request = chat.itemOfKind("user-request")!;
    expect(request.expiresAt).toEqual(expect.any(Number));

    // The test's dialog deadline is 600ms; the item expires without an answer and pi is told.
    const statusOf = (view: Follow) => {
      const item = view.item(request.id);
      return item?.kind === "user-request" ? item.status : undefined;
    };
    await expect
      .poll(() => statusOf(chat), { timeout: 10_000, message: "the expired request" })
      .toBe("expired");
    expect(chat.item(request.id)).toMatchObject({ kind: "user-request", status: "expired" });
    expect(chat.item(request.id)).not.toHaveProperty("answer");
    await waitForStatus(api, session.id, "done");
  } finally {
    await chat.close();
  }
});

test("an abort stops the turn, leaves no item streaming and reports idle", async () => {
  vi.stubEnv("FAKE_PI_RPC", "slow");
  vi.stubEnv("FAKE_PI_RPC_DELAY_MS", "2000");
  const { api, session } = await chatTask();
  const chat = follow(api, session.id);
  try {
    await chat.until((view) => view.state.turn === "working", "the running turn");
    await api.chat.abort({ sessionId: session.id });
    await chat.until((view) => view.state.turn === "aborted", "the aborted turn");
    expect(chat.itemOfKind("assistant-message")?.streaming ?? false).toBe(false);
    await waitForStatus(api, session.id, "idle");
  } finally {
    await chat.close();
  }
});

test("a crash retains the accepted initial prompt with an unknown boundary on resume", async () => {
  vi.stubEnv("FAKE_PI_RPC", "crash");
  vi.stubEnv("FAKE_PI_RPC_CRASH_DELAY_MS", "300");
  const { api, session } = await chatTask();
  const chat = follow(api, session.id);
  try {
    await chat.until((view) => view.itemOfKind("error") !== undefined, "the crash reason");
    expect(chat.itemOfKind("error")?.text).toMatch(/pi exited unexpectedly \(code 3\)/);
  } finally {
    await chat.close();
  }

  await expect
    .poll(async () => (await sessionsOf(api)).find((candidate) => candidate.id === session.id), {
      timeout: 10_000,
      message: "the stopped session",
    })
    .toMatchObject({
      state: "stopped",
      launchError: "pi exited unexpectedly (code 3)",
    });
  await waitForStatus(api, session.id, "error");
  await expect(firstMessage(api.chat.watch({ sessionId: session.id }))).rejects.toMatchObject({
    code: "CHAT_UNAVAILABLE",
    data: { reason: "exited", message: "pi exited unexpectedly (code 3)" },
  });

  vi.stubEnv("FAKE_PI_RPC", "normal");
  const restarted = await api.sessions.restart({ id: session.id, size: SIZE });
  expect(restarted).toMatchObject({ state: "running", view: "chat", terminalId: null });
  const again = follow(api, session.id);
  try {
    await again.until(
      (view) => view.state.queue?.some((entry) => entry.status === "boundary-unknown") === true,
      "the prompt with unknown boundary",
    );
    expect(again.state.queue).toContainEqual(
      expect.objectContaining({
        text: "Add a note to notes.txt",
        status: "boundary-unknown",
      }),
    );
    await expect(
      api.chat.send({ sessionId: session.id, text: "later", mode: "prompt" }),
    ).rejects.toMatchObject({ code: "CHAT_UNAVAILABLE", data: { reason: "turn-unconfirmed" } });
  } finally {
    await again.close();
  }
});

test("a line that is not a record ends the frontend with the parse failure as the reason", async () => {
  vi.stubEnv("FAKE_PI_RPC", "badline");
  const { api, session } = await chatTask();
  const chat = follow(api, session.id);
  try {
    await chat.until((view) => view.itemOfKind("error") !== undefined, "the parse failure");
    expect(chat.itemOfKind("error")?.text).toMatch(/not a JSON record/);
  } finally {
    await chat.close();
  }
  await expect
    .poll(
      async () => (await sessionsOf(api)).find((candidate) => candidate.id === session.id)?.state,
      { timeout: 10_000, message: "the stopped session" },
    )
    .toBe("stopped");
});

test("a record cut off without LF fails the frontend with the parse reason", async () => {
  vi.stubEnv("FAKE_PI_RPC", "truncate");
  const { api, session } = await chatTask();
  const chat = follow(api, session.id);
  try {
    await chat.until((view) => view.itemOfKind("error") !== undefined, "the parse failure");
    expect(chat.itemOfKind("error")?.text).toMatch(/not a JSON record/);
  } finally {
    await chat.close();
  }
  await expect
    .poll(async () => (await sessionsOf(api)).find((candidate) => candidate.id === session.id), {
      timeout: 10_000,
      message: "the stopped session",
    })
    .toMatchObject({ state: "stopped", launchError: expect.stringContaining("not a JSON record") });
});

test("settling the task leaves its chat child running; a prompt makes the task active", async () => {
  const { api, task, session } = await chatTask("Keep it");
  const first = follow(api, session.id);
  try {
    await first.until((view) => view.itemOfKind("user-request") !== undefined, "the dialog");
    await api.chat.respond({
      sessionId: session.id,
      requestId: first.itemOfKind("user-request")!.id,
      value: true,
    });
    await first.until((view) => view.state.turn === "settled", "the settled turn");
  } finally {
    await first.close();
  }
  const [launch] = await agents.launches();

  await api.tasks.setState({ id: task.id, state: "settled" });
  // Settle never stops a session: the chat child keeps its process and its view stays usable.
  expect(processExists(launch!.pid)).toBe(true);
  const live = follow(api, session.id);
  try {
    await live.until(
      (view) => view.itemOfKind("user-message") !== undefined,
      "the rebuilt history",
    );
    expect(live.itemOfKind("user-message")).toMatchObject({ text: "Keep it" });

    // A prompt in a settled task is new work: it makes the task active and the same child answers.
    await api.chat.send({ sessionId: session.id, text: "one more", mode: "prompt" });
    await live.until(
      (view) => view.items.filter((item) => item.kind === "user-message").length === 2,
      "the prompt in the same process",
    );
    await live.until((view) => view.state.turn === "settled", "the second settled turn");
  } finally {
    await live.close();
  }
  expect(await taskStateOf(api, task.id)).toBe("active");
  expect((await sessionsOf(api)).find((candidate) => candidate.id === session.id)?.state).toBe(
    "running",
  );
  expect(await agents.launches()).toEqual([launch]);
});

test("a prompt is refused while the first turn is unconfirmed and accepted after it settles", async () => {
  const { api, session } = await chatTask("First turn");
  const chat = follow(api, session.id);
  try {
    await chat.until(
      (view) => view.itemOfKind("user-request") !== undefined,
      "the first turn's dialog",
    );
    // The initial attempt is still the one the turn belongs to: a second prompt would be a second
    // writer, so the boundary refuses it instead of queueing it as a prompt.
    await expect(
      api.chat.send({ sessionId: session.id, text: "during the turn", mode: "prompt" }),
    ).rejects.toMatchObject({ code: "CHAT_UNAVAILABLE", data: { reason: "turn-unconfirmed" } });

    await api.chat.respond({
      sessionId: session.id,
      requestId: chat.itemOfKind("user-request")!.id,
      value: true,
    });
    await chat.until((view) => view.state.turn === "settled", "the settled first turn");

    // The settled boundary released both the initial attempt and `initialPending`; the next
    // prompt is a new turn on the same frontend, not a refusal.
    await api.chat.send({ sessionId: session.id, text: "after the turn", mode: "prompt" });
    await chat.until(
      (view) => view.items.filter((item) => item.kind === "user-message").length === 2,
      "the prompt after the settled turn",
    );
    expect(chat.items.findLast((item) => item.kind === "user-message")).toMatchObject({
      text: "after the turn",
    });
  } finally {
    await chat.close();
  }
  expect(
    (await piCommands(session.agentSessionId!)).filter((entry) => entry.type === "prompt"),
  ).toMatchObject([{ text: "First turn" }, { text: "after the turn" }]);
});

test("a message pi refuses is an error item, and the frontend keeps running", async () => {
  vi.stubEnv("FAKE_PI_RPC", "reject");
  const { api, session } = await chatTask();
  const chat = follow(api, session.id);
  try {
    await chat.until((view) => view.itemOfKind("error") !== undefined, "the refusal");
    expect(chat.itemOfKind("error")?.text).toBe(
      "pi did not accept the message: pi refused prompt: the fake pi rejects messages",
    );
    expect(chat.itemOfKind("user-message")).toMatchObject({ text: "Add a note to notes.txt" });
    expect(chat.state.turn).toBe("idle");
    expect((await sessionsOf(api)).find((candidate) => candidate.id === session.id)?.state).toBe(
      "running",
    );
  } finally {
    await chat.close();
  }
});

test("a cursor from before a restarted frontend gets a snapshot instead of a replay", async () => {
  const { api, session } = await chatTask("Cursor");
  const first = follow(api, session.id);
  try {
    await first.until((view) => view.itemOfKind("user-request") !== undefined, "the dialog");
    await api.chat.respond({
      sessionId: session.id,
      requestId: first.itemOfKind("user-request")!.id,
      value: true,
    });
    await first.until((view) => view.state.turn === "settled", "the settled turn");
  } finally {
    await first.close();
  }

  await api.sessions.stop({ id: session.id });
  await api.sessions.restart({ id: session.id, size: SIZE });
  // A low cursor a previous client could hold. Wait until the rebuilt timeline is past it: only
  // then is a replay possible at all, so the assertion below is about the rule, not about a race.
  const rebuilt = follow(api, session.id);
  try {
    await rebuilt.until((view) => view.sequence > 1, "the rebuilt history");
  } finally {
    await rebuilt.close();
  }
  const iterator = (await api.chat.watch({ sessionId: session.id, after: 1 }))[
    Symbol.asyncIterator
  ]();
  try {
    const message = await within(iterator.next(), "the first message of the resumed chat");
    expect(message.value).toMatchObject({ type: "snapshot" });
  } finally {
    await iterator.return?.(undefined);
  }
});

test("two watchers with a cursor from before a server restart both get a snapshot", async () => {
  const { api, session } = await chatTask("Two watchers");
  const first = follow(api, session.id);
  try {
    await first.until((view) => view.itemOfKind("user-request") !== undefined, "the dialog");
    await api.chat.respond({
      sessionId: session.id,
      requestId: first.itemOfKind("user-request")!.id,
      value: true,
    });
    await first.until((view) => view.state.turn === "settled", "the settled turn");
  } finally {
    await first.close();
  }

  await server.restart();
  const restarted = await server.rpc();
  // Past the stale cursor, so a replay is possible at all: the assertion is about the rule.
  const rebuilt = follow(restarted, session.id);
  try {
    await rebuilt.until((view) => view.sequence > 1, "the rebuilt timeline");
  } finally {
    await rebuilt.close();
  }

  const a = (await restarted.chat.watch({ sessionId: session.id, after: 1 }))[
    Symbol.asyncIterator
  ]();
  const b = (await restarted.chat.watch({ sessionId: session.id, after: 1 }))[
    Symbol.asyncIterator
  ]();
  try {
    const both = await Promise.all([within(a.next(), "watcher a"), within(b.next(), "watcher b")]);
    expect(both[0].value).toMatchObject({ type: "snapshot" });
    expect(both[1].value).toMatchObject({ type: "snapshot" });
  } finally {
    await a.return?.(undefined);
    await b.return?.(undefined);
  }
});

test("a stop kills the whole process group when pi ignores stdin EOF", async () => {
  vi.stubEnv("FAKE_PI_RPC", "noeof");
  const { api, session } = await chatTask();
  const grandchildFile = join(
    agents.piRpcHome,
    `${session.agentSessionId!.replace(/[^A-Za-z0-9._-]/g, "_")}.grandchild`,
  );
  await expect
    .poll(async () => (existsSync(grandchildFile) ? readFile(grandchildFile, "utf8") : ""), {
      timeout: 10_000,
      message: "the fake's grandchild",
    })
    .toMatch(/^\d+$/);
  const grandchild = Number(await readFile(grandchildFile, "utf8"));
  const [launch] = await agents.launches();
  expect(processExists(launch!.pid)).toBe(true);
  expect(processExists(grandchild)).toBe(true);

  // stdin closing does not stop this child; the exit deadline passes and the group is killed.
  // SIGKILL delivery is asynchronous, so both deaths are polled.
  await api.sessions.stop({ id: session.id });

  await expect
    .poll(async () => processExists(launch!.pid), { timeout: 10_000, message: "the child" })
    .toBe(false);
  await expect
    .poll(async () => processExists(grandchild), { timeout: 10_000, message: "the grandchild" })
    .toBe(false);
});

test("a silent child fails the frontend at the ready deadline and is killed", async () => {
  vi.stubEnv("FAKE_PI_RPC", "silent");
  const { api, session } = await chatTask();

  await expect
    .poll(async () => (await sessionsOf(api)).find((candidate) => candidate.id === session.id), {
      timeout: 10_000,
      message: "the failed frontend",
    })
    .toMatchObject({ state: "stopped", launchError: expect.stringContaining("did not answer") });
  expect(
    (await sessionsOf(api)).find((candidate) => candidate.id === session.id)?.status?.state,
  ).toBe("error");
  const [launch] = await agents.launches();
  await expect
    .poll(async () => processExists(launch!.pid), { timeout: 10_000, message: "the killed child" })
    .toBe(false);
  await expect(firstMessage(api.chat.watch({ sessionId: session.id }))).rejects.toMatchObject({
    code: "CHAT_UNAVAILABLE",
    data: { reason: "exited" },
  });
});

test("removing a chat session forgets its persisted sequence floor", async () => {
  const { api, session } = await chatTask("Floor");
  const floor = floorPath(join(server.dataDir, "chat"), session.id);
  await expect.poll(() => existsSync(floor), { timeout: 10_000, message: "the floor" }).toBe(true);

  await api.sessions.remove({ id: session.id });

  expect(existsSync(floor)).toBe(false);
});

test("the view is validated, and chat refuses a terminal session, a stopped one and an unknown id", async () => {
  const { api, task } = await chatTask();
  await expect(
    api.sessions.start({ taskId: task.id, kind: "shell", view: "chat", size: SIZE }),
  ).rejects.toMatchObject({
    code: "LAUNCH_VIEW_UNSUPPORTED",
    data: { kind: "shell", view: "chat" },
  });
  // Every agent this build ships has a chat driver, so only a shell is refused; the no-driver
  // branch is covered where the registry can be narrowed (`chat-driver.test.ts`). Codex now opens
  // a chat session beside its app-server.
  const codex = await api.sessions.start({
    taskId: task.id,
    kind: "codex",
    view: "chat",
    size: SIZE,
  });
  expect(codex).toMatchObject({ kind: "codex", view: "chat" });
  await api.sessions.stop({ id: codex.id });

  const terminal = await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });
  expect(terminal.view).toBe("terminal");
  await expect(firstMessage(api.chat.watch({ sessionId: terminal.id }))).rejects.toMatchObject({
    code: "CHAT_UNAVAILABLE",
    data: { reason: "no-driver" },
  });
  await expect(firstMessage(api.chat.watch({ sessionId: "nope" }))).rejects.toMatchObject({
    code: "SESSION_NOT_FOUND",
  });

  // A chat session that was stopped by the user can be started again, so it is `not-started`.
  const { session } = await chatTask("Second", "second");
  await api.sessions.stop({ id: session.id });
  await expect(firstMessage(api.chat.watch({ sessionId: session.id }))).rejects.toMatchObject({
    code: "CHAT_UNAVAILABLE",
    data: { reason: "not-started" },
  });
});

test("a steer reaches pi and is reported as steering while the turn runs", async () => {
  vi.stubEnv("FAKE_PI_RPC", "slow");
  vi.stubEnv("FAKE_PI_RPC_DELAY_MS", "1500");
  const { api, session } = await chatTask();
  const chat = follow(api, session.id);
  try {
    await chat.until((view) => view.state.turn === "working", "the running turn");
    const steeringId = await api.chat.send({
      sessionId: session.id,
      text: "stop and look right",
      mode: "steer",
    });
    expect(chat.item(steeringId)).toMatchObject({
      kind: "user-message",
      text: "stop and look right",
    });
    await chat.until((view) => view.state.steering.includes("stop and look right"), "the queue");
    await api.chat.abort({ sessionId: session.id });
  } finally {
    await chat.close();
  }
});

test("the model and reasoning level switch through the driver and are reported by the session state", async () => {
  const { api, session } = await chatTask("Model please");
  await settleTurn(api, session.id, "Model please");
  const chat = follow(api, session.id);
  try {
    await chat.until(
      (view) => view.state.model !== null && view.state.reasoningLevels.length > 0,
      "the model state",
    );
    expect(chat.state.model).toEqual({ provider: "stub", id: "stub-1", name: "Stub One" });
    expect(chat.state.models.map((model) => model.id)).toEqual(["stub-1", "stub-2"]);
    expect(chat.state.reasoning).toBe("medium");
    expect(chat.state.reasoningLevels).toEqual(["off", "low", "medium", "high"]);

    await api.chat.setModel({
      sessionId: session.id,
      model: { provider: "stub", id: "stub-2" },
      level: "high",
    });
    await chat.until((view) => view.state.model?.id === "stub-2", "the new model");
    await chat.until((view) => view.state.reasoning === "high", "the new reasoning level");

    await expect(
      api.chat.setModel({
        sessionId: session.id,
        model: { provider: "stub", id: "stub-1" },
        level: "not-a-level",
      }),
    ).rejects.toMatchObject({
      code: "CHAT_MODEL_LEVEL_PARTIAL",
      data: { model: { provider: "stub", id: "stub-1" }, level: "not-a-level" },
    });
    await chat.until(
      (view) => view.state.model?.id === "stub-1" && view.state.modelSelectionPending === false,
      "the partial result",
    );

    await expect(
      api.chat.setModel({ sessionId: session.id, model: { provider: "stub", id: "stub-9" } }),
    ).rejects.toMatchObject({ code: "CHAT_MODEL_UNSUPPORTED" });
  } finally {
    await chat.close();
  }
});

test("a successful model switch followed by a failed refresh never advertises the previous model's thinking", async () => {
  vi.stubEnv("FAKE_PI_RPC", "refresh-fail");
  const { api, task } = await chatTask("Refresh capabilities");
  const sessionId = task.primarySessionId!;
  await settleTurn(api, sessionId, "Refresh capabilities");
  const chat = follow(api, sessionId);
  try {
    await chat.until((view) => view.state.reasoningLevels.length > 0, "initial thinking");
    await api.chat.setModel({ sessionId, model: { provider: "stub", id: "stub-2" } });
    await chat.until((view) => view.state.reasoningStatus === "error", "failed refresh");
    expect(chat.state.reasoningLevels).toEqual([]);
    expect(chat.state.reasoning).toBeNull();
    await api.chat.send({ sessionId, text: "send with unknown thinking", mode: "prompt" });
    await chat.until(
      (view) =>
        view.items.some(
          (item) => item.kind === "user-message" && item.text === "send with unknown thinking",
        ),
      "the prompt without a claimed thinking level",
    );
  } finally {
    await chat.close();
  }
});

test("a silent model refresh ends the frontend rather than blocking later messages indefinitely", async () => {
  vi.stubEnv("FAKE_PI_RPC", "refresh-silent");
  const { api, session } = await chatTask("Refresh capabilities");
  await settleTurn(api, session.id, "Refresh capabilities");
  const chat = follow(api, session.id);
  try {
    await chat.until((view) => view.state.reasoningLevels.length > 0, "initial thinking");
    const change = api.chat.setModel({
      sessionId: session.id,
      model: { provider: "stub", id: "stub-2" },
    });
    await chat.until((view) => view.state.reasoningStatus === "loading", "refresh in progress");
    const message = api.chat.send({ sessionId: session.id, text: "next", mode: "prompt" });
    await change.catch(() => undefined);
    await expect(message).rejects.toMatchObject({ code: "CHAT_UNAVAILABLE" });
  } finally {
    await chat.close();
  }
});

/** One entry of the fake pi's command journal: what a turn actually ran on. */
interface PiCommand {
  type: string;
  text?: string | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  level?: string | undefined;
}

/** The fake pi's journal for one conversation: accepted messages and applied model/level commands. */
const PiCommandJournal = z.array(
  z.object({
    type: z.string(),
    text: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    level: z.string().optional(),
  }),
);

async function piCommands(agentSessionId: string): Promise<PiCommand[]> {
  const safe = agentSessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  const text = await readFile(join(agents.piRpcHome, `${safe}.commands.json`), "utf8").catch(
    () => "",
  );
  return text === "" ? [] : PiCommandJournal.parse(JSON.parse(text));
}

test("a pre-launch pi model and level reach the first prompt, then survive restart without replay", async () => {
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  const { project } = await addProject(server, "prelaunch");
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "first chosen prompt",
    agent: {
      kind: "pi",
      view: "chat",
      model: "stub/stub-2",
      thinking: { model: { provider: "stub", id: "stub-2" }, level: "high" },
    },
    workspace: { type: "main-worktree" },
  });
  const session = (await sessionsOf(api)).find((entry) => entry.id === task.primarySessionId)!;
  const chat = follow(api, session.id);
  try {
    await chat.until((view) => view.state.turn === "settled", "the first chosen turn");
    expect(
      (await piCommands(session.agentSessionId!)).find((entry) => entry.type === "prompt"),
    ).toMatchObject({ text: "first chosen prompt", model: "stub-2", level: "high" });
    expect(chat.state.selection).toEqual({
      model: { provider: "stub", id: "stub-2" },
      level: "high",
    });
  } finally {
    await chat.close();
  }
  await server.restart();
  const api2 = await server.rpc();
  const resumed = follow(api2, session.id);
  try {
    await resumed.until((view) => view.state.selection?.level === "high", "the retained choice");
    expect(
      (await piCommands(session.agentSessionId!)).filter((entry) => entry.type === "prompt"),
    ).toHaveLength(1);
  } finally {
    await resumed.close();
  }
  const second = await api2.sessions.start({
    taskId: task.id,
    kind: "pi",
    view: "chat",
    size: SIZE,
    model: "stub/stub-2",
  });
  const secondChat = follow(api2, second.id);
  try {
    await secondChat.until(
      (view) => view.state.selection?.level === "high",
      "the remembered level in another session",
    );
    await api2.chat.send({ sessionId: second.id, text: "remembered turn", mode: "prompt" });
    await secondChat.until(
      (view) =>
        view.items.some((item) => item.kind === "user-message" && item.text === "remembered turn"),
      "the second session's prompt",
    );
    await expect
      .poll(async () =>
        (await piCommands(second.agentSessionId!)).find((entry) => entry.type === "prompt"),
      )
      .toMatchObject({ text: "remembered turn", model: "stub-2", level: "high" });
  } finally {
    await secondChat.close();
  }
  await writeFile(
    join(agents.piRpcHome, "levels.json"),
    JSON.stringify({ "stub-2": ["off", "low"] }),
  );
  const unavailable = await api2.sessions.start({
    taskId: task.id,
    kind: "pi",
    view: "chat",
    size: SIZE,
    model: "stub/stub-2",
  });
  const unavailableChat = follow(api2, unavailable.id);
  try {
    await unavailableChat.until(
      (view) => view.state.reasoningStatus === "ready",
      "the fresh report without the remembered level",
    );
    await api2.chat.send({ sessionId: unavailable.id, text: "use native default", mode: "prompt" });
    await unavailableChat.until(
      (view) =>
        view.items.some(
          (item) => item.kind === "user-message" && item.text === "use native default",
        ),
      "the native-default prompt",
    );
    await expect
      .poll(async () =>
        (await piCommands(unavailable.agentSessionId!)).find((entry) => entry.type === "prompt"),
      )
      .toMatchObject({ text: "use native default", model: "stub-2" });
    const commands = await piCommands(unavailable.agentSessionId!);
    expect(commands.filter((entry) => entry.type === "level")).toEqual([]);
  } finally {
    await unavailableChat.close();
  }
  await rm(join(agents.piRpcHome, "levels.json"));
  const restored = await api2.sessions.start({
    taskId: task.id,
    kind: "pi",
    view: "chat",
    size: SIZE,
    model: "stub/stub-2",
  });
  const restoredChat = follow(api2, restored.id);
  try {
    await restoredChat.until(
      (view) => view.state.selection?.level === "high",
      "the remembered level after it becomes available again",
    );
  } finally {
    await restoredChat.close();
  }
  await configureProfiles();
  const otherProfile = await api2.sessions.start({
    taskId: task.id,
    kind: "pi",
    view: "chat",
    size: SIZE,
    profileId: "pi-one",
    model: "stub/stub-2",
  });
  const otherChat = follow(api2, otherProfile.id);
  try {
    await otherChat.until((view) => view.state.models.length > 0, "the other profile's model list");
    await api2.chat.send({ sessionId: otherProfile.id, text: "profile default", mode: "prompt" });
    await otherChat.until(
      (view) =>
        view.items.some((item) => item.kind === "user-message" && item.text === "profile default"),
      "the other profile's prompt",
    );
    expect(
      (await piCommands(otherProfile.agentSessionId!)).find((entry) => entry.type === "prompt"),
    ).toMatchObject({ text: "profile default", model: "stub-2", level: "medium" });
  } finally {
    await otherChat.close();
  }
});

test("an unoffered direct pi launch cannot poison another session's thinking memory", async () => {
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  const { project } = await addProject(server, "pi-direct-memory");
  const api = await server.rpc();
  const scope = { kind: "pi" as const, profileId: null };
  const model = { provider: "stub", id: "stub-2" };
  await api.models.rememberThinking({
    scope,
    context: { projectId: project.id },
    model,
    level: "high",
  });
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "keep unoffered pi prompt",
    agent: {
      kind: "pi",
      view: "chat",
      model: "stub/stub-2",
      thinking: { model, level: "fake-level" },
    },
    workspace: { type: "main-worktree" },
  });
  const session = (await sessionsOf(api)).find((entry) => entry.id === task.primarySessionId)!;
  const chat = follow(api, session.id);
  try {
    await chat.until(
      (view) =>
        view.items.some(
          (item) => item.kind === "error" && item.text.includes("keep unoffered pi prompt"),
        ),
      "the refused first prompt",
    );
    expect(await api.models.thinking({ scope, model })).toBe("high");
    expect(
      (await piCommands(session.agentSessionId!)).filter((entry) => entry.type === "prompt"),
    ).toEqual([]);
  } finally {
    await chat.close();
  }
});

test("a direct pi choice cannot overwrite a newer client's memory while native confirmation waits", async () => {
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  const { project } = await addProject(server, "pi-memory-race");
  const api = await server.rpc();
  const other = await server.rpc();
  const scope = { kind: "pi" as const, profileId: null };
  const model = { provider: "stub", id: "stub-2" };
  await mkdir(agents.piRpcHome, { recursive: true });
  await writeFile(join(agents.piRpcHome, "hold-thinking"), "");
  try {
    const task = await api.tasks.create({
      projectId: project.id,
      prompt: "captured pi high",
      agent: { kind: "pi", view: "chat", model: "stub/stub-2", thinking: { model, level: "high" } },
      workspace: { type: "main-worktree" },
    });
    const session = (await sessionsOf(api)).find((entry) => entry.id === task.primarySessionId)!;
    await expect.poll(() => existsSync(join(agents.piRpcHome, "thinking-waiting"))).toBe(true);
    await other.models.rememberThinking({
      scope,
      context: { projectId: project.id },
      model,
      level: "max",
    });
    await rm(join(agents.piRpcHome, "hold-thinking"));
    const chat = follow(api, session.id);
    try {
      await chat.until((view) => view.state.turn === "settled", "the captured pi turn");
      await expect
        .poll(async () =>
          (await piCommands(session.agentSessionId!)).find((entry) => entry.type === "prompt"),
        )
        .toMatchObject({ text: "captured pi high", level: "high" });
      expect(await other.models.thinking({ scope, model })).toBe("max");
    } finally {
      await chat.close();
    }
  } finally {
    await rm(join(agents.piRpcHome, "hold-thinking"), { force: true });
  }
});

test("a direct pi choice can be confirmed by its live driver when metadata discovery fails", async () => {
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  const { project } = await addProject(server, "pi-live-memory");
  const api = await server.rpc();
  const scope = { kind: "pi" as const, profileId: null };
  const model = { provider: "stub", id: "stub-2" };
  await mkdir(agents.piRpcHome, { recursive: true });
  await writeFile(join(agents.piRpcHome, "catalog-only-error"), "");
  expect((await api.models.catalog({ scope, context: { projectId: project.id } })).status).toBe(
    "error",
  );
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "live pi confirmation",
    agent: { kind: "pi", view: "chat", model: "stub/stub-2", thinking: { model, level: "high" } },
    workspace: { type: "main-worktree" },
  });
  const session = (await sessionsOf(api)).find((entry) => entry.id === task.primarySessionId)!;
  const chat = follow(api, session.id);
  try {
    await chat.until((view) => view.state.turn === "settled", "the confirmed first turn");
    expect(await api.models.thinking({ scope, model })).toBe("high");
  } finally {
    await chat.close();
  }
});

test("a pre-launch pi level that is not offered never sends the first prompt", async () => {
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  const { project } = await addProject(server, "prelaunch-refused");
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "keep my first prompt",
    agent: {
      kind: "pi",
      view: "chat",
      model: "stub/stub-1",
      thinking: { model: { provider: "stub", id: "stub-1" }, level: "max" },
    },
    workspace: { type: "main-worktree" },
  });
  const session = (await sessionsOf(api)).find((entry) => entry.id === task.primarySessionId)!;
  const chat = follow(api, session.id);
  try {
    await chat.until(
      (view) =>
        view.items.some(
          (item) => item.kind === "error" && item.text.includes("keep my first prompt"),
        ),
      "the retained prompt and refusal",
    );
    expect(
      (await piCommands(session.agentSessionId!)).filter((entry) => entry.type === "prompt"),
    ).toEqual([]);
    expect(task.prompt).toBe("keep my first prompt");
  } finally {
    await chat.close();
  }
});

test("a pi launch that does not confirm the selected model keeps the first prompt unsent", async () => {
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  vi.stubEnv("FAKE_PI_IGNORE_LAUNCH_MODEL", "1");
  const { project } = await addProject(server, "prelaunch-model-refused");
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "keep this model prompt",
    agent: {
      kind: "pi",
      view: "chat",
      model: "stub/stub-2",
      expectedModel: { provider: "stub", id: "stub-2" },
    },
    workspace: { type: "main-worktree" },
  });
  const session = (await sessionsOf(api)).find((entry) => entry.id === task.primarySessionId)!;
  const chat = follow(api, session.id);
  try {
    await chat.until(
      (view) =>
        view.state.queue?.some(
          (entry) => entry.text === "keep this model prompt" && entry.status === "undelivered",
        ) === true,
      "the prompt retained after the model mismatch",
    );
    expect(
      (await piCommands(session.agentSessionId!)).filter((entry) => entry.type === "prompt"),
    ).toEqual([]);
  } finally {
    await chat.close();
  }
});

test.each([
  ["native default", undefined, "medium"],
  ["explicit off", { model: { provider: "stub", id: "stub-1" }, level: "off" }, "off"],
] as const)("pi first prompt distinguishes %s", async (_name, thinking, expected) => {
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  const { project } = await addProject(server, "default-or-off");
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "the first prompt",
    agent: {
      kind: "pi",
      view: "chat",
      model: "stub/stub-1",
      expectedModel: { provider: "stub", id: "stub-1" },
      ...(thinking === undefined ? {} : { thinking }),
    },
    workspace: { type: "main-worktree" },
  });
  const session = (await sessionsOf(api)).find((entry) => entry.id === task.primarySessionId)!;
  const chat = follow(api, session.id);
  try {
    await chat.until((view) => view.state.turn === "settled", "the completed first turn");
    const commands = await piCommands(session.agentSessionId!);
    expect(commands.find((entry) => entry.type === "prompt")).toMatchObject({
      text: "the first prompt",
      level: expected,
    });
    expect(commands.filter((entry) => entry.type === "level")).toHaveLength(
      thinking === undefined ? 0 : 1,
    );
  } finally {
    await chat.close();
  }
});

test("pi uses the native level when choosing a model without a remembered choice", async () => {
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  const { api, session } = await chatTask("initial default");
  const chat = follow(api, session.id);
  try {
    await chat.until(
      (view) => view.state.turn === "settled" && (view.state.queue?.length ?? 0) === 0,
      "the first turn's boundary",
    );
    await api.chat.setModel({ sessionId: session.id, model: { provider: "stub", id: "stub-2" } });
    expect(chat.state.selection).toEqual({
      model: { provider: "stub", id: "stub-2" },
      level: null,
    });
    await api.chat.send({ sessionId: session.id, text: "native choice", mode: "prompt" });
    await chat.until(
      (view) =>
        view.items.some((item) => item.kind === "user-message" && item.text === "native choice"),
      "the prompt with no explicit level",
    );
    await expect
      .poll(async () =>
        (await piCommands(session.agentSessionId!)).find((entry) => entry.text === "native choice"),
      )
      .toMatchObject({ model: "stub-2", level: "medium" });
    expect(
      (await piCommands(session.agentSessionId!)).filter((entry) => entry.type === "level"),
    ).toEqual([]);
  } finally {
    await chat.close();
  }
});

test("pi can choose a model with no selectable thinking levels", async () => {
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  await mkdir(agents.piRpcHome, { recursive: true });
  await writeFile(join(agents.piRpcHome, "levels.json"), JSON.stringify({ "stub-2": [] }));
  const { api, session } = await chatTask("initial before plain");
  const chat = follow(api, session.id);
  try {
    await chat.until(
      (view) => view.state.turn === "settled" && (view.state.queue?.length ?? 0) === 0,
      "the first turn's boundary",
    );
    await api.chat.setModel({ sessionId: session.id, model: { provider: "stub", id: "stub-2" } });
    await api.chat.send({ sessionId: session.id, text: "plain model", mode: "prompt" });
    await chat.until(
      (view) =>
        view.items.some((item) => item.kind === "user-message" && item.text === "plain model"),
      "the plain model's prompt",
    );
    await expect
      .poll(async () =>
        (await piCommands(session.agentSessionId!)).find((entry) => entry.text === "plain model"),
      )
      .toMatchObject({ model: "stub-2" });
    expect(
      (await piCommands(session.agentSessionId!)).filter((entry) => entry.type === "level"),
    ).toEqual([]);
  } finally {
    await chat.close();
  }
});

test("pi restores the new model's native setting after a different model's explicit level", async () => {
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  const { api, session } = await chatTask("initial explicit transition");
  const chat = follow(api, session.id);
  try {
    await chat.until(
      (view) => view.state.turn === "settled" && (view.state.queue?.length ?? 0) === 0,
      "the first turn's boundary",
    );
    await api.chat.setReasoning({ sessionId: session.id, level: "high" });
    await api.chat.setModel({ sessionId: session.id, model: { provider: "stub", id: "stub-2" } });
    await api.chat.send({ sessionId: session.id, text: "after explicit high", mode: "prompt" });
    await chat.until(
      (view) =>
        view.items.some(
          (item) => item.kind === "user-message" && item.text === "after explicit high",
        ),
      "the prompt on the new model",
    );
    await expect
      .poll(async () =>
        (await piCommands(session.agentSessionId!)).find(
          (entry) => entry.text === "after explicit high",
        ),
      )
      .toMatchObject({ model: "stub-2", level: "medium" });
    const commands = await piCommands(session.agentSessionId!);
    expect(commands.filter((entry) => entry.type === "level")).toHaveLength(1);
  } finally {
    await chat.close();
  }
});

test("a queued pi turn captures the model without forcing a thinking level", async () => {
  vi.stubEnv("FAKE_PI_RPC", "slow");
  vi.stubEnv("FAKE_PI_RPC_DELAY_MS", "500");
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  const { api, session } = await chatTask("running default queue");
  const chat = follow(api, session.id);
  try {
    await chat.until((view) => view.state.turn === "working", "the first turn");
    await api.chat.setModel({ sessionId: session.id, model: { provider: "stub", id: "stub-2" } });
    await api.chat.send({ sessionId: session.id, text: "queued default", mode: "follow-up" });
    await api.chat.setModel({
      sessionId: session.id,
      model: { provider: "stub", id: "stub-1" },
      level: "high",
    });
    await chat.until(
      (view) =>
        view.items.some((item) => item.kind === "user-message" && item.text === "queued default"),
      "the queued default turn",
    );
    await expect
      .poll(async () =>
        (await piCommands(session.agentSessionId!)).find(
          (entry) => entry.text === "queued default",
        ),
      )
      .toMatchObject({ model: "stub-2", level: "medium" });
  } finally {
    await chat.close();
  }
});

/** Answers the fake's pending dialog and waits for that turn to settle. */
async function finishTurn(chat: Follow, api: Api, sessionId: string): Promise<void> {
  await chat.until(
    (view) => view.items.some((item) => item.kind === "user-request" && item.status === "pending"),
    "the fake's dialog",
  );
  const request = chat.items.find(
    (item): item is Extract<ChatItem, { kind: "user-request" }> =>
      item.kind === "user-request" && item.status === "pending",
  )!;
  await api.chat.respond({ sessionId, requestId: request.id, value: true });
  await chat.until((view) => view.state.turn === "settled", "the settled turn");
}

/** Two pi profiles, so a thinking choice can be shown to stay inside its profile. */
async function configureProfiles(): Promise<void> {
  await mkdir(server.configDir, { recursive: true });
  await writeFile(
    join(server.configDir, "config.toml"),
    `[profiles.pi-one]\nname = "Pi One"\nagent = "pi"\n\n[profiles.pi-two]\nname = "Pi Two"\nagent = "pi"\n`,
  );
  const updates = await (await server.rpc()).config.watch();
  try {
    await within(
      (async () => {
        for await (const raw of updates) {
          if (ConfigState.parse(raw).profiles.length === 2) return;
        }
        throw new Error("config.watch ended before the profiles arrived");
      })(),
      "the two profiles",
    );
  } finally {
    await updates.return?.();
  }
}

test("a choice made during a turn reaches the queued turn, while the steer stays on the running model", async () => {
  vi.stubEnv("FAKE_PI_RPC", "slow");
  vi.stubEnv("FAKE_PI_RPC_DELAY_MS", "700");
  const { api, session } = await chatTask("Start on A");
  const agentSessionId = session.agentSessionId!;
  const chat = follow(api, session.id);
  try {
    await chat.until(
      (view) => view.state.turn === "working" && view.state.models.length > 0,
      "the running turn",
    );
    await api.chat.setModel({
      sessionId: session.id,
      model: { provider: "stub", id: "stub-2" },
      level: "high",
    });
    await chat.until((view) => view.state.selection?.model.id === "stub-2", "the next-turn choice");
    // The running turn keeps the model it started on; the driver was not switched under it.
    expect(chat.state.model).toEqual({ provider: "stub", id: "stub-1", name: "Stub One" });
    expect(await piCommands(agentSessionId)).toEqual([
      expect.objectContaining({ type: "prompt", text: "Start on A", model: "stub-1" }),
    ]);

    await api.chat.send({ sessionId: session.id, text: "steer on A", mode: "steer" });
    const queuedId = await api.chat.send({
      sessionId: session.id,
      text: "second turn",
      mode: "follow-up",
    });
    await chat.until((view) => view.state.followUp.includes("second turn"), "the queue");
    expect(chat.state.queue?.find((entry) => entry.id === queuedId)).toMatchObject({
      text: "second turn",
      selection: { model: { provider: "stub", id: "stub-2" }, level: "high" },
      status: "queued",
    });

    // A later choice changes the composer; it does not change the queued message.
    await api.chat.setModel({
      sessionId: session.id,
      model: { provider: "stub", id: "stub-1" },
      level: "low",
    });
    await chat.until((view) => view.state.selection?.level === "low", "the later choice");
    // Still no switch while the first turn runs.
    expect((await piCommands(agentSessionId)).filter((entry) => entry.type === "model")).toEqual(
      [],
    );

    await finishTurn(chat, api, session.id);
    await chat.until(
      (view) =>
        view.items.some((item) => item.kind === "user-message" && item.text === "second turn"),
      "the queued turn",
    );
    await chat.until((view) => view.state.model?.id === "stub-2", "the queued turn's model");
    await finishTurn(chat, api, session.id);
    // With the queue empty, the session's later choice is applied at the boundary.
    await chat.until(
      (view) => view.state.model?.id === "stub-1" && view.state.reasoning === "low",
      "the next-turn choice applied",
    );
    expect(chat.state.selection).toEqual({
      model: { provider: "stub", id: "stub-1" },
      level: "low",
    });

    const commands = await piCommands(agentSessionId);
    expect(commands.filter((entry) => entry.type === "prompt")).toMatchObject([
      { text: "Start on A", model: "stub-1", level: "medium" },
      { text: "second turn", model: "stub-2", level: "high" },
    ]);
    expect(commands.find((entry) => entry.type === "steer")).toMatchObject({
      text: "steer on A",
      model: "stub-1",
    });
  } finally {
    await chat.close();
  }
});

test("pi accepts successive ordinary messages after confirmed idle boundaries", async () => {
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  const { api, session } = await chatTask("initial");
  const chat = follow(api, session.id);
  try {
    for (const text of ["first normal", "second normal"]) {
      // oxlint-disable-next-line no-await-in-loop -- each user turn starts after the preceding boundary
      await chat.until(
        (view) => view.state.turn === "settled" && (view.state.queue?.length ?? 0) === 0,
        "the previous confirmed boundary",
      );
      // oxlint-disable-next-line no-await-in-loop -- ordered user turns
      await api.chat.send({ sessionId: session.id, text, mode: "prompt" });
      // oxlint-disable-next-line no-await-in-loop -- the next iteration must observe this turn
      await chat.until(
        (view) => view.items.some((item) => item.kind === "user-message" && item.text === text),
        text,
      );
    }
    await chat.until(
      (view) => view.state.turn === "settled" && (view.state.queue?.length ?? 0) === 0,
      "the last confirmed boundary",
    );
    expect(
      (await piCommands(session.agentSessionId!)).filter((entry) => entry.type === "prompt"),
    ).toMatchObject([{ text: "initial" }, { text: "first normal" }, { text: "second normal" }]);
  } finally {
    await chat.close();
  }
});

test("pi holds the captured queued model through post-settlement compaction", async () => {
  vi.stubEnv("FAKE_PI_RPC", "slow");
  vi.stubEnv("FAKE_PI_RPC_DELAY_MS", "500");
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  vi.stubEnv("FAKE_PI_RPC_POST_SETTLE_COMPACTION", "1");
  const { api, session } = await chatTask("A");
  const chat = follow(api, session.id);
  try {
    await chat.until((view) => view.state.turn === "working", "A working");
    await api.chat.setModel({
      sessionId: session.id,
      model: { provider: "stub", id: "stub-2" },
      level: "high",
    });
    await api.chat.send({ sessionId: session.id, text: "steer A", mode: "steer" });
    await api.chat.send({ sessionId: session.id, text: "B", mode: "follow-up" });
    await chat.until(
      (view) =>
        view.items.some((item) => item.kind === "user-request" && item.status === "pending"),
      "the compaction gate",
    );
    const request = chat.items.find(
      (item): item is Extract<ChatItem, { kind: "user-request" }> =>
        item.kind === "user-request" && item.status === "pending",
    )!;
    expect((await piCommands(session.agentSessionId!)).map((entry) => entry.type)).toEqual([
      "prompt",
      "steer",
      "compaction-start",
    ]);
    await api.chat.respond({ sessionId: session.id, requestId: request.id, value: true });
    await chat.until(
      (view) => view.items.some((item) => item.kind === "user-message" && item.text === "B"),
      "B after compaction",
    );
    const commands = await piCommands(session.agentSessionId!);
    expect(commands.findIndex((entry) => entry.type === "model")).toBeGreaterThan(
      commands.findIndex((entry) => entry.type === "compaction-end"),
    );
    expect(commands.find((entry) => entry.type === "prompt" && entry.text === "B")).toMatchObject({
      model: "stub-2",
      level: "high",
    });
  } finally {
    await chat.close();
  }
});

test("pi does not cross a settled event while a steer acknowledgement is outstanding", async () => {
  vi.stubEnv("FAKE_PI_RPC", "slow");
  vi.stubEnv("FAKE_PI_RPC_DELAY_MS", "500");
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  vi.stubEnv("FAKE_PI_RPC_HOLD_STEER_ACK", "1");
  const { api, session } = await chatTask("A awaiting steer");
  const chat = follow(api, session.id);
  const id = session.agentSessionId!;
  try {
    await chat.until((view) => view.state.turn === "working", "A working");
    await api.chat.setModel({
      sessionId: session.id,
      model: { provider: "stub", id: "stub-2" },
      level: "high",
    });
    await api.chat.send({ sessionId: session.id, text: "steer pending", mode: "steer" });
    await api.chat.send({ sessionId: session.id, text: "B waiting", mode: "follow-up" });
    await chat.until((view) => view.state.turn === "settled", "A's preliminary settled event");
    await api.chat.setModel({
      sessionId: session.id,
      model: { provider: "stub", id: "stub-1" },
      level: "low",
    });
    const before = await piCommands(id);
    expect(before.map((entry) => entry.type)).toContain("steer-awaiting-ack");
    expect(before.some((entry) => entry.type === "model" || entry.text === "B waiting")).toBe(
      false,
    );
    const safe = id.replace(/[^A-Za-z0-9._-]/g, "_");
    await writeFile(join(agents.piRpcHome, `${safe}.steer-release`), "");
    await chat.until(
      (view) =>
        view.items.some((item) => item.kind === "user-message" && item.text === "B waiting"),
      "B after the steer acknowledgement",
    );
    const after = await piCommands(id);
    expect(
      after.find((entry) => entry.type === "prompt" && entry.text === "B waiting"),
    ).toMatchObject({
      model: "stub-2",
      level: "high",
    });
  } finally {
    await chat.close();
  }
});

test("queued turns run in order, each on the model it captured", async () => {
  vi.stubEnv("FAKE_PI_RPC", "slow");
  vi.stubEnv("FAKE_PI_RPC_DELAY_MS", "400");
  const { api, session } = await chatTask("Queue order");
  const agentSessionId = session.agentSessionId!;
  const chat = follow(api, session.id);
  try {
    await chat.until(
      (view) => view.state.turn === "working" && view.state.models.length > 0,
      "the running turn",
    );
    await api.chat.setModel({
      sessionId: session.id,
      model: { provider: "stub", id: "stub-2" },
      level: "max",
    });
    await chat.until((view) => view.state.selection?.level === "max", "the first choice");
    await api.chat.send({ sessionId: session.id, text: "first", mode: "follow-up" });
    await api.chat.setModel({
      sessionId: session.id,
      model: { provider: "stub", id: "stub-1" },
      level: "medium",
    });
    await chat.until((view) => view.state.selection?.model.id === "stub-1", "the second choice");
    await api.chat.send({ sessionId: session.id, text: "second", mode: "follow-up" });
    await chat.until((view) => view.state.followUp.length === 2, "both queued messages");
    expect(chat.state.followUp).toEqual(["first", "second"]);

    await finishTurn(chat, api, session.id);
    await chat.until(
      (view) => view.items.some((item) => item.kind === "user-message" && item.text === "first"),
      "the first queued turn",
    );
    await chat.until((view) => view.state.model?.id === "stub-2", "the first queued model");
    await chat.until((view) => view.state.followUp.length === 1, "one message left");
    expect(chat.state.followUp).toEqual(["second"]);
    await finishTurn(chat, api, session.id);
    await chat.until(
      (view) => view.items.some((item) => item.kind === "user-message" && item.text === "second"),
      "the second queued turn",
    );
    await chat.until((view) => view.state.model?.id === "stub-1", "the second queued model");
    await finishTurn(chat, api, session.id);

    const commands = await piCommands(agentSessionId);
    expect(commands.filter((entry) => entry.type === "prompt").map((entry) => entry.text)).toEqual([
      "Queue order",
      "first",
      "second",
    ]);
    expect(
      commands.find((entry) => entry.type === "prompt" && entry.text === "first"),
    ).toMatchObject({ model: "stub-2", level: "max" });
    expect(
      commands.find((entry) => entry.type === "prompt" && entry.text === "second"),
    ).toMatchObject({ model: "stub-1", level: "medium" });
  } finally {
    await chat.close();
  }
});

test("two clients see one selection and one queue", async () => {
  vi.stubEnv("FAKE_PI_RPC", "slow");
  vi.stubEnv("FAKE_PI_RPC_DELAY_MS", "800");
  const { api, session } = await chatTask("Two clients");
  const other = await server.rpc();
  const left = follow(api, session.id);
  const right = follow(other, session.id);
  try {
    await left.until((view) => view.state.turn === "working", "the running turn");
    await right.until((view) => view.state.turn === "working", "the other client's turn");

    await api.chat.setModel({
      sessionId: session.id,
      model: { provider: "stub", id: "stub-2" },
      level: "high",
    });
    await other.chat.setModel({
      sessionId: session.id,
      model: { provider: "stub", id: "stub-1" },
      level: "low",
    });
    await left.until((view) => view.state.selection?.level === "low", "the final choice");
    await right.until((view) => view.state.selection?.level === "low", "the same final choice");
    expect(left.state.selection).toEqual(right.state.selection);

    await api.chat.send({ sessionId: session.id, text: "from A", mode: "follow-up" });
    await other.chat.send({ sessionId: session.id, text: "from B", mode: "follow-up" });
    await left.until((view) => view.state.followUp.length === 2, "both messages");
    await right.until((view) => view.state.followUp.length === 2, "both messages here too");
    expect(left.state.followUp).toEqual(["from A", "from B"]);
    expect(right.state.followUp).toEqual(left.state.followUp);
    expect(right.state.queue).toEqual(left.state.queue);

    await api.chat.abort({ sessionId: session.id });
  } finally {
    await left.close();
    await right.close();
  }
});

test("an abort leaves the queue unsent and says so instead of resending it", async () => {
  vi.stubEnv("FAKE_PI_RPC", "slow");
  vi.stubEnv("FAKE_PI_RPC_DELAY_MS", "800");
  const { api, session } = await chatTask("Abort with a queue");
  const agentSessionId = session.agentSessionId!;
  const chat = follow(api, session.id);
  try {
    await chat.until((view) => view.state.turn === "working", "the running turn");
    await api.chat.send({ sessionId: session.id, text: "never sent", mode: "follow-up" });
    await chat.until((view) => view.state.followUp.includes("never sent"), "the queue");
    await api.chat.abort({ sessionId: session.id });
    await chat.until((view) => view.state.turn === "aborted", "the aborted turn");
    await chat.until(
      (view) =>
        view.items.some((item) => item.kind === "error" && item.text.includes("never sent")),
      "the visible unsent message",
    );
    expect(chat.state.followUp).toEqual([]);
    expect(chat.state.queue).toContainEqual(
      expect.objectContaining({ text: "never sent", status: "undelivered" }),
    );

    await chat.until(
      (view) => view.state.queue?.some((entry) => entry.text === "Abort with a queue") === false,
      "the confirmed aborted boundary",
    );
    await api.chat.send({ sessionId: session.id, text: "after the stop", mode: "prompt" });
    expect(
      (await piCommands(agentSessionId)).filter((entry) => entry.text === "never sent"),
    ).toEqual([]);
  } finally {
    await chat.close();
  }
});

test("a restart keeps a queued message unsent and shows it when the session resumes", async () => {
  vi.stubEnv("FAKE_PI_RPC", "slow");
  vi.stubEnv("FAKE_PI_RPC_DELAY_MS", "1200");
  const { api, session } = await chatTask("Restart with a queue");
  const agentSessionId = session.agentSessionId!;
  const chat = follow(api, session.id);
  try {
    await chat.until((view) => view.state.turn === "working", "the running turn");
    await api.chat.setModel({
      sessionId: session.id,
      model: { provider: "stub", id: "stub-2" },
      level: "high",
    });
    await chat.until((view) => view.state.selection?.level === "high", "the next-turn choice");
    await api.chat.send({ sessionId: session.id, text: "lost in the restart", mode: "follow-up" });
    await chat.until((view) => view.state.followUp.includes("lost in the restart"), "the queue");
  } finally {
    await chat.close();
  }

  // The running session is restored from the same data directory; its turn was cut off, so the
  // queued message must not be started again.
  await server.restart();
  const api2 = await server.rpc();
  const resumed = follow(api2, session.id);
  try {
    await resumed.until(
      (view) =>
        view.items.some(
          (item) => item.kind === "error" && item.text.includes("lost in the restart"),
        ),
      "the unsent message after the restart",
    );
    expect(resumed.state.selection).toEqual({
      model: { provider: "stub", id: "stub-2" },
      level: "high",
    });
    expect(resumed.state.queue).toContainEqual(
      expect.objectContaining({
        status: "undelivered",
        selection: { model: { provider: "stub", id: "stub-2" }, level: "high" },
      }),
    );
    expect(
      (await piCommands(agentSessionId)).filter(
        (entry) => entry.type === "prompt" && entry.text === "lost in the restart",
      ),
    ).toEqual([]);
  } finally {
    await resumed.close();
  }
});

test("a queue row a crash left in flight is uncertain, and neither resent nor dropped", async () => {
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  const { api, session } = await chatTask("Crash queue");
  const agentSessionId = session.agentSessionId!;
  const first = follow(api, session.id);
  try {
    await first.until((view) => view.state.turn === "settled", "the settled first turn");
  } finally {
    await first.close();
  }
  await api.sessions.stop({ id: session.id });

  // The two rows a crash can leave: one attempt recorded just before its send, and one that never
  // started. A restart is the only place that can tell them apart.
  const db = new DatabaseSync(join(server.dataDir, "corral.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const insert = db.prepare(
      `INSERT INTO chat_queue (id, session_id, text, selection, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const selection = JSON.stringify({
      model: { provider: "stub", id: "stub-1" },
      level: null,
    });
    insert.run("queued:crash-sending", session.id, "might have been sent", selection, "sending", 1);
    insert.run("queued:crash-queued", session.id, "never started", selection, "queued", 2);
  } finally {
    db.close();
  }

  await server.restart();
  const api2 = await server.rpc();
  await api2.sessions.restart({ id: session.id, size: SIZE });
  const resumed = follow(api2, session.id);
  try {
    await resumed.until(
      (view) => view.state.queue?.some((entry) => entry.status === "uncertain-idle") === true,
      "idle recovery with uncertain delivery preserved",
    );
    expect(resumed.state.queue?.map((entry) => entry.status)).toEqual([
      "uncertain-idle",
      "undelivered",
    ]);
    const prompts = (await piCommands(agentSessionId))
      .filter((entry) => entry.type === "prompt")
      .map((entry) => entry.text);
    expect(prompts).not.toContain("might have been sent");
    expect(prompts).not.toContain("never started");
    const other = await server.rpc();
    await other.chat.send({ sessionId: session.id, text: "continue safely", mode: "prompt" });
    await resumed.until(
      (view) =>
        view.items.some((item) => item.kind === "user-message" && item.text === "continue safely"),
      "the other client's new message",
    );
    await resumed.until(
      (view) =>
        view.state.queue?.some((entry) => entry.text === "continue safely") === false &&
        view.state.turn === "settled",
      "the new message's confirmed boundary",
    );
    expect(
      resumed.state.queue?.find((entry) => entry.text === "might have been sent")?.status,
    ).toBe("uncertain-idle");
  } finally {
    await resumed.close();
  }
  await writeFile(join(agents.piRpcHome, "recovery-busy"), "");
  await server.restart();
  const api3 = await server.rpc();
  const reopened = follow(api3, session.id);
  try {
    await reopened.until(
      (view) =>
        view.state.queue?.some(
          (entry) => entry.text === "might have been sent" && entry.status === "uncertain",
        ) === true,
      "delivery uncertainty rechecked on the next frontend",
    );
    await expect(
      api3.chat.send({ sessionId: session.id, text: "must recheck", mode: "prompt" }),
    ).rejects.toMatchObject({ code: "CHAT_UNAVAILABLE", data: { reason: "turn-unconfirmed" } });
  } finally {
    await reopened.close();
  }
});

test("an abort leaves later entries paused behind the active turn's unknown boundary", async () => {
  vi.stubEnv("FAKE_PI_RPC", "slow");
  vi.stubEnv("FAKE_PI_RPC_DELAY_MS", "600");
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  vi.stubEnv("FAKE_PI_RPC_HOLD_ABORT_PROBE", "1");
  const { api, session } = await chatTask("First turn");
  const agentSessionId = session.agentSessionId!;
  const chat = follow(api, session.id);
  try {
    await chat.until((view) => view.state.turn === "working", "the running turn");
    await api.chat.send({ sessionId: session.id, text: "lost one", mode: "follow-up" });
    await api.chat.send({ sessionId: session.id, text: "lost two", mode: "follow-up" });
    await chat.until((view) => view.state.followUp.length === 2, "both queued messages");
    await api.chat.abort({ sessionId: session.id });
    await chat.until((view) => view.state.turn === "aborted", "the aborted turn");
    await chat.until(
      (view) =>
        view.state.queue?.filter((entry) => entry.status === "undelivered").length === 2 &&
        view.state.queue.some(
          (entry) => entry.text === "First turn" && entry.status === "accepted",
        ),
      "both stopped entries",
    );

    await expect(
      api.chat.send({ sessionId: session.id, text: "after the stop", mode: "prompt" }),
    ).rejects.toMatchObject({ code: "CHAT_UNAVAILABLE", data: { reason: "turn-unconfirmed" } });
    await api.chat.send({ sessionId: session.id, text: "new queued", mode: "follow-up" });
    await chat.until(
      (view) =>
        view.state.queue?.some(
          (entry) => entry.text === "new queued" && entry.status === "queued",
        ) === true,
      "the paused later entry",
    );

    const prompts = (await piCommands(agentSessionId))
      .filter((entry) => entry.type === "prompt")
      .map((entry) => entry.text);
    expect(prompts).toEqual(["First turn"]);
  } finally {
    await chat.close();
  }
});

test("pi resumes after an idle check without resending the prior attempt or paused queue", async () => {
  vi.stubEnv("FAKE_PI_RPC", "slow");
  vi.stubEnv("FAKE_PI_RPC_DELAY_MS", "900");
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  const { api, session } = await chatTask("Before the restart");
  const agentSessionId = session.agentSessionId!;
  const chat = follow(api, session.id);
  try {
    await chat.until((view) => view.state.turn === "working", "the running turn");
    await api.chat.send({ sessionId: session.id, text: "old one", mode: "follow-up" });
    await api.chat.send({ sessionId: session.id, text: "old two", mode: "follow-up" });
    await chat.until((view) => view.state.followUp.length === 2, "both queued messages");
  } finally {
    await chat.close();
  }

  await server.restart();
  const api2 = await server.rpc();
  const resumed = follow(api2, session.id);
  try {
    await resumed.until(
      (view) =>
        view.state.queue?.filter((entry) => entry.status === "undelivered").length === 2 &&
        view.state.queue.some((entry) => entry.status === "accepted-idle"),
      "idle recovery with both stopped entries",
    );
    await api2.chat.send({ sessionId: session.id, text: "after restart", mode: "prompt" });
    await resumed.until(
      (view) =>
        view.items.some((item) => item.kind === "user-message" && item.text === "after restart"),
      "the new turn",
    );
    // The view's user-message is appended when the send is addressed, before the child reads its
    // stdin, so the journal can still be a poll behind it.
    await expect
      .poll(
        async () =>
          (await piCommands(agentSessionId))
            .filter((entry) => entry.type === "prompt")
            .map((entry) => entry.text),
        { timeout: 10_000, message: "the prompt journal" },
      )
      .toContain("after restart");
    const prompts = (await piCommands(agentSessionId))
      .filter((entry) => entry.type === "prompt")
      .map((entry) => entry.text);
    expect(prompts.filter((text) => text === "after restart")).toHaveLength(1);
    expect(prompts.filter((text) => text === "Before the restart")).toHaveLength(1);
    expect(prompts).not.toContain("old one");
    expect(prompts).not.toContain("old two");
  } finally {
    await resumed.close();
  }
});

test.each([
  ["compaction", "recovery-busy"],
  ["new activity during the idle check", "recovery-race"],
  ["an outstanding automatic retry", "recovery-retry"],
] as const)("pi keeps recovery blocked on %s", async (_description, marker) => {
  vi.stubEnv("FAKE_PI_RPC", "slow");
  vi.stubEnv("FAKE_PI_RPC_DELAY_MS", "900");
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  const { api, session } = await chatTask("Compacting on resume");
  const chat = follow(api, session.id);
  try {
    await chat.until((view) => view.state.turn === "working", "the original turn");
  } finally {
    await chat.close();
  }
  await writeFile(join(agents.piRpcHome, marker), "");
  await server.restart();
  const api2 = await server.rpc();
  const resumed = follow(api2, session.id);
  try {
    await resumed.until(
      (view) => view.state.queue?.some((entry) => entry.status === "boundary-unknown") === true,
      "the unresolved boundary",
    );
    await expect(
      api2.chat.send({ sessionId: session.id, text: "not while unconfirmed", mode: "prompt" }),
    ).rejects.toMatchObject({ code: "CHAT_UNAVAILABLE", data: { reason: "turn-unconfirmed" } });
    expect(
      (await piCommands(session.agentSessionId!)).some(
        (entry) => entry.text === "not while unconfirmed",
      ),
    ).toBe(false);
  } finally {
    await resumed.close();
  }
});

test("pi waits for compaction and steer acknowledgement before recovering the old prompt", async () => {
  vi.stubEnv("FAKE_PI_RPC", "slow");
  vi.stubEnv("FAKE_PI_RPC_DELAY_MS", "900");
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  vi.stubEnv("FAKE_PI_RPC_HOLD_STEER_ACK", "1");
  const { api, session } = await chatTask("Before resumed compaction");
  const chat = follow(api, session.id);
  try {
    await chat.until((view) => view.state.turn === "working", "the original turn");
  } finally {
    await chat.close();
  }
  await writeFile(join(agents.piRpcHome, "recovery-gated"), "");
  await server.restart();
  const api2 = await server.rpc();
  const resumed = follow(api2, session.id);
  try {
    await resumed.until(
      (view) =>
        view.state.queue?.some((entry) => entry.status === "boundary-unknown") === true &&
        view.items.some((item) => item.kind === "user-request" && item.status === "pending"),
      "the resumed compaction gate",
    );
    await expect(
      api2.chat.send({ sessionId: session.id, text: "too early", mode: "prompt" }),
    ).rejects.toMatchObject({ code: "CHAT_UNAVAILABLE", data: { reason: "turn-unconfirmed" } });
    await api2.chat.send({ sessionId: session.id, text: "pending steer", mode: "steer" });
    await resumed.until(
      (view) => view.state.steering.includes("pending steer"),
      "the steer awaiting acknowledgement",
    );
    await api2.chat.setModel({
      sessionId: session.id,
      model: { provider: "stub", id: "stub-2" },
      level: "high",
    });
    const request = resumed.items.find(
      (item): item is Extract<ChatItem, { kind: "user-request" }> =>
        item.kind === "user-request" && item.status === "pending",
    )!;
    await api2.chat.respond({ sessionId: session.id, requestId: request.id, value: true });
    await resumed.until(
      (view) =>
        view.items.some(
          (item) =>
            item.kind === "user-request" && item.id === request.id && item.status !== "pending",
        ),
      "the compaction gate closed",
    );
    await expect(
      api2.chat.send({ sessionId: session.id, text: "before steer ack", mode: "prompt" }),
    ).rejects.toMatchObject({ code: "CHAT_UNAVAILABLE", data: { reason: "turn-unconfirmed" } });
    expect(
      (await piCommands(session.agentSessionId!)).some((entry) => entry.type === "model"),
    ).toBe(false);
    const safe = session.agentSessionId!.replace(/[^A-Za-z0-9._-]/g, "_");
    await writeFile(join(agents.piRpcHome, `${safe}.steer-release`), "");
    await resumed.until(
      (view) => view.state.queue?.some((entry) => entry.status === "accepted-idle") === true,
      "the post-compaction idle check",
    );
    await api2.chat.send({ sessionId: session.id, text: "after compaction", mode: "prompt" });
    await resumed.until(
      (view) =>
        view.items.some((item) => item.kind === "user-message" && item.text === "after compaction"),
      "the new prompt",
    );
    const commands = await piCommands(session.agentSessionId!);
    const prompts = commands.filter((entry) => entry.type === "prompt").map((entry) => entry.text);
    expect(prompts.filter((text) => text === "Before resumed compaction")).toHaveLength(1);
    expect(prompts).not.toContain("too early");
    expect(prompts).not.toContain("before steer ack");
    expect(commands.find((entry) => entry.text === "after compaction")).toMatchObject({
      model: "stub-2",
      level: "high",
    });
  } finally {
    await resumed.close();
  }
});

test("a message still being accepted when the server stops is uncertain and never resent", async () => {
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  // The fake answers the message command late, so the attempt is in flight when the server stops.
  vi.stubEnv("FAKE_PI_RPC_ACCEPT_DELAY_MS", "1500");
  const { api, session } = await chatTask("Settled first");
  const agentSessionId = session.agentSessionId!;
  const first = follow(api, session.id);
  try {
    await first.until((view) => view.state.turn === "settled", "the settled first turn");
  } finally {
    await first.close();
  }

  await api.chat.send({ sessionId: session.id, text: "in flight", mode: "follow-up" });
  const sending = follow(api, session.id);
  try {
    await sending.until(
      (view) =>
        view.state.queue?.some(
          (entry) => entry.text === "in flight" && entry.status === "sending",
        ) === true,
      "the attempt recorded before its answer",
    );
    // The row is still in the durable queue at this point, not removed on `send` returning.
    expect(sending.state.queue?.find((entry) => entry.text === "in flight")?.status).toBe(
      "sending",
    );
  } finally {
    await sending.close();
  }

  await server.restart();
  const api2 = await server.rpc();
  const resumed = follow(api2, session.id);
  try {
    await resumed.until(
      (view) =>
        view.state.queue?.some(
          (entry) => entry.text === "in flight" && entry.status === "uncertain",
        ) === true,
      "the interrupted attempt",
    );
    await resumed.until(
      (view) => view.items.some((item) => item.kind === "error" && item.text.includes("in flight")),
      "the visible text",
    );
    expect(
      (await piCommands(agentSessionId)).filter((entry) => entry.text === "in flight"),
    ).toEqual([]);
  } finally {
    await resumed.close();
  }
});

test("a message the agent refuses after the send stays visible and is not retried", async () => {
  vi.stubEnv("FAKE_PI_RPC", "reject");
  vi.stubEnv("FAKE_PI_RPC_ACCEPT_DELAY_MS", "300");
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  const { api, session } = await chatTask("Rejected prompt");
  const agentSessionId = session.agentSessionId!;
  const chat = follow(api, session.id);
  const id = await api.chat.send({
    sessionId: session.id,
    text: "refused later",
    mode: "follow-up",
  });
  try {
    await chat.until(
      (view) => view.state.queue?.find((entry) => entry.id === id)?.status === "undelivered",
      "the refused entry",
    );
    expect(chat.state.queue?.find((entry) => entry.id === id)?.text).toBe("refused later");
    await chat.until(
      (view) =>
        view.items.some((item) => item.kind === "error" && item.text.includes("refused later")),
      "the visible refusal",
    );
  } finally {
    await chat.close();
  }

  // A session restart reopens the same queue; the refused entry stays stopped, and a new message
  // queued after it runs once the agent accepts again.
  vi.stubEnv("FAKE_PI_RPC", "normal");
  vi.stubEnv("FAKE_PI_RPC_ACCEPT_DELAY_MS", "0");
  await api.sessions.stop({ id: session.id });
  await api.sessions.restart({ id: session.id, size: SIZE });
  const resumed = follow(api, session.id);
  try {
    await resumed.until((view) => view.state.models.length > 0, "the restarted driver");
    await api.chat.send({ sessionId: session.id, text: "after the refusal", mode: "follow-up" });
    await resumed.until(
      (view) =>
        view.items.some(
          (item) => item.kind === "user-message" && item.text === "after the refusal",
        ),
      "the new queued turn",
    );
    await resumed.until((view) => view.state.turn === "settled", "its settled boundary");
    const prompts = (await piCommands(agentSessionId))
      .filter((entry) => entry.type === "prompt")
      .map((entry) => entry.text);
    // The task prompt was refused before it could write history, so the resumed launch hands it
    // over again; the refused queue entry is not retried and the later one runs.
    expect(prompts).toContain("after the refusal");
    expect(prompts).not.toContain("refused later");
    expect(resumed.state.queue?.find((entry) => entry.id === id)?.status).toBe("undelivered");
  } finally {
    await resumed.close();
  }
});

test("a prompt whose stored model is gone is refused instead of running on another one", async () => {
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  const { api, session } = await chatTask("Model disappears");
  const agentSessionId = session.agentSessionId!;
  const first = follow(api, session.id);
  try {
    await first.until((view) => view.state.turn === "settled", "the settled first turn");
    await api.chat.setModel({
      sessionId: session.id,
      model: { provider: "stub", id: "stub-2" },
      level: "max",
    });
    await first.until((view) => view.state.reasoning === "max", "the chosen model");
  } finally {
    await first.close();
  }
  await api.sessions.stop({ id: session.id });
  // The next launch's catalog no longer has the chosen model.
  await writeFile(
    join(agents.piRpcHome, "catalog.json"),
    JSON.stringify([{ id: "stub-1", name: "Stub One", provider: "stub" }]),
  );
  await api.sessions.restart({ id: session.id, size: SIZE });

  const resumed = follow(api, session.id);
  try {
    await resumed.until(
      (view) =>
        view.items.some(
          (item) =>
            item.kind === "error" &&
            item.text.includes("The selected model or thinking level could not be applied"),
        ),
      "the visible failure",
    );
    // The selection is still the user's; the running frontend stays on the model it has.
    expect(resumed.state.selection).toEqual({
      model: { provider: "stub", id: "stub-2" },
      level: "max",
    });
    expect(resumed.state.model?.id).toBe("stub-1");
    await expect(
      api.chat.send({ sessionId: session.id, text: "must not leave", mode: "prompt" }),
    ).rejects.toMatchObject({ code: "CHAT_MODEL_UNSUPPORTED" });
    expect(
      (await piCommands(agentSessionId)).filter(
        (entry) => entry.type === "prompt" && entry.text === "must not leave",
      ),
    ).toEqual([]);
  } finally {
    await resumed.close();
  }
});

test("a level the driver silently clamps is reported as not applied, not as a success", async () => {
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  vi.stubEnv("FAKE_PI_RPC_CLAMP", "high:medium");
  const { api, session } = await chatTask("Clamped level");
  const first = follow(api, session.id);
  try {
    await first.until(
      (view) => view.state.turn === "settled" && view.state.reasoningLevels.length > 0,
      "the settled first turn",
    );
    await expect(
      api.chat.setReasoning({ sessionId: session.id, level: "high" }),
    ).rejects.toMatchObject({ code: "CHAT_REASONING_UNSUPPORTED" });
    await first.until((view) => view.state.reasoningStatus === "ready", "the read-back");
    // The requested level stays the user's; the state reports what pi actually kept, and does not
    // present the refused level as the one a turn would run on.
    await first.until(
      (view) => view.state.selectionIssue?.reason === "unavailable",
      "the refused level",
    );
    expect(first.state.reasoning).toBe("medium");
    expect(first.state.selection).toMatchObject({ level: "high" });
    expect(first.state.selectionIssue).toEqual({ level: "high", reason: "unavailable" });
    await expect(
      api.chat.send({ sessionId: session.id, text: "must not leave", mode: "prompt" }),
    ).rejects.toMatchObject({ code: "CHAT_REASONING_UNSUPPORTED" });
  } finally {
    await first.close();
  }
});

test("a thinking level is remembered per agent, profile and model, and an unavailable one is not applied", async () => {
  await configureProfiles();
  const { api, task } = await addTask(server, "Memory", "main-worktree");
  const openChat = async (profileId: string) => {
    const session = await api.sessions.start({
      taskId: task.id,
      kind: "pi",
      view: "chat",
      profileId,
      size: SIZE,
    });
    const chat = follow(api, session.id);
    await chat.until((view) => view.state.models.length > 0, "the driver's models");
    return { session, chat };
  };

  const first = await openChat("pi-one");
  await api.chat.setModel({
    sessionId: first.session.id,
    model: { provider: "stub", id: "stub-2" },
    level: "max",
  });
  await first.chat.until((view) => view.state.reasoning === "max", "the explicit level");

  // Another profile never made that choice, so it gets no level from it.
  const otherProfile = await openChat("pi-two");
  await api.chat.setModel({
    sessionId: otherProfile.session.id,
    model: { provider: "stub", id: "stub-2" },
  });
  await otherProfile.chat.until(
    (view) => view.state.model?.id === "stub-2" && view.state.reasoningStatus === "ready",
    "the other profile's switch",
  );
  expect(otherProfile.chat.state.selection?.level).toBeNull();
  expect(otherProfile.chat.state.reasoning).toBe("medium");
  // The first session's choice is its own row; another session cannot overwrite it.
  expect(first.chat.state.selection).toEqual({
    model: { provider: "stub", id: "stub-2" },
    level: "max",
  });

  // The same profile and model reuse the remembered level.
  const again = await openChat("pi-one");
  await api.chat.setModel({
    sessionId: again.session.id,
    model: { provider: "stub", id: "stub-2" },
  });
  await again.chat.until((view) => view.state.reasoning === "max", "the remembered level");

  // No memory is not an explicit level: the launch model is chosen without claiming one.
  const off = await openChat("pi-one");
  await api.chat.setModel({ sessionId: off.session.id, model: { provider: "stub", id: "stub-1" } });
  await off.chat.until((view) => view.state.model?.id === "stub-1", "the first model");
  expect(off.chat.state.selection?.level).toBeNull();
  await api.chat.setReasoning({ sessionId: off.session.id, level: "off" });
  await off.chat.until((view) => view.state.reasoning === "off", "the explicit off level");
  const offAgain = await openChat("pi-one");
  await api.chat.setModel({
    sessionId: offAgain.session.id,
    model: { provider: "stub", id: "stub-1" },
  });
  await offAgain.chat.until((view) => view.state.reasoning === "off", "the remembered off level");

  // A level the model no longer offers stays in the selection and the memory, and is not applied.
  await writeFile(
    join(agents.piRpcHome, "levels.json"),
    JSON.stringify({ "stub-2": ["off", "medium", "high"] }),
  );
  const gone = await openChat("pi-one");
  await api.chat.setModel({
    sessionId: gone.session.id,
    model: { provider: "stub", id: "stub-2" },
  });
  await gone.chat.until(
    (view) =>
      view.state.model?.id === "stub-2" &&
      view.state.reasoningStatus === "ready" &&
      view.state.selectionIssue?.reason === "unavailable",
    "the switch without its level",
  );
  expect(gone.chat.state.selection).toEqual({
    model: { provider: "stub", id: "stub-2" },
    level: "max",
  });
  // The fake pi reports its native setting after the model switch, not the unavailable memory.
  expect(gone.chat.state.reasoning).toBe("medium");
  expect(gone.chat.state.selectionIssue).toEqual({ level: "max", reason: "unavailable" });

  // A failed discovery is not proof the level was removed: the memory still applies when the
  // driver offers it again.
  await rm(join(agents.piRpcHome, "levels.json"));
  await writeFile(join(agents.piRpcHome, "catalog-error"), "");
  const catalog = await api.models.catalog({
    scope: { kind: "pi", profileId: "pi-one" },
    context: { taskId: task.id },
  });
  expect(catalog.status).toBe("error");
  await rm(join(agents.piRpcHome, "catalog-error"));
  const restored = await openChat("pi-one");
  await api.chat.setModel({
    sessionId: restored.session.id,
    model: { provider: "stub", id: "stub-2" },
  });
  await restored.chat.until(
    (view) => view.state.reasoning === "max" && view.state.selectionIssue === null,
    "the level used again",
  );
});

/** Answers the fake's dialog and waits for the turn to settle, so the conversation has history. */
async function settleTurn(api: Api, sessionId: string, text = "Add a note to notes.txt") {
  const chat = follow(api, sessionId);
  try {
    await chat.until((view) => view.itemOfKind("user-request") !== undefined, "the dialog");
    expect(chat.itemOfKind("user-message")).toMatchObject({ text });
    await api.chat.respond({
      sessionId,
      requestId: chat.itemOfKind("user-request")!.id,
      value: true,
    });
    await chat.until((view) => view.state.turn === "settled", "the settled turn");
  } finally {
    await chat.close();
  }
}

/** Waits until the fake pi has been launched `count` times and returns those launches. */
function piLaunches(count: number) {
  return launchesOf(agents, "pi", count);
}

/** The argv of every fake pi launch, oldest first. */
async function piArgv(): Promise<string[][]> {
  return (await agents.launches()).map((launch) => launch.argv);
}

/**
 * The marker the fake pi writes when a second frontend of one session id starts while the previous
 * one is alive. A handoff must never produce it: the test asserts at the boundary, not only after.
 */
function overlapMarker(agentSessionId: string): string {
  return join(agents.piRpcHome, `${agentSessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.overlap.json`);
}

test("a level applied before a model stops offering it is remembered, not applied, and returns", async () => {
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  const { api, session } = await chatTask("Applied level");
  const agentSessionId = session.agentSessionId!;
  const first = follow(api, session.id);
  try {
    await first.until((view) => view.state.turn === "settled", "the settled turn");
    await api.chat.setModel({
      sessionId: session.id,
      model: { provider: "stub", id: "stub-2" },
      level: "max",
    });
    await first.until((view) => view.state.reasoning === "max", "the applied level");
  } finally {
    await first.close();
  }
  await api.sessions.stop({ id: session.id });

  // The next launch's fresh catalog no longer takes `max` on stub-2, while the agent was actually
  // running at it before the stop.
  await writeFile(
    join(agents.piRpcHome, "levels.json"),
    JSON.stringify({ "stub-2": ["off", "medium", "high"] }),
  );
  await api.sessions.restart({ id: session.id, size: SIZE });
  const resumed = follow(api, session.id);
  try {
    await resumed.until(
      (view) => view.state.selectionIssue?.reason === "unavailable",
      "the unapplied level",
    );
    // The choice and its memory survive; the reported level is what the agent actually runs, and a
    // turn is refused rather than delivered on that other level.
    expect(resumed.state.selection).toEqual({
      model: { provider: "stub", id: "stub-2" },
      level: "max",
    });
    expect(resumed.state.reasoning).toBe("medium");
    await expect(
      api.chat.send({ sessionId: session.id, text: "must not leave", mode: "prompt" }),
    ).rejects.toMatchObject({ code: "CHAT_REASONING_UNSUPPORTED" });
    await expect(
      api.chat.send({ sessionId: session.id, text: "must not queue", mode: "follow-up" }),
    ).rejects.toMatchObject({ code: "CHAT_REASONING_UNSUPPORTED" });
    expect(resumed.state.queue ?? []).toEqual([]);
    expect(
      (await piCommands(agentSessionId)).filter((entry) => entry.text === "must not leave"),
    ).toEqual([]);
  } finally {
    await resumed.close();
  }
  await api.sessions.stop({ id: session.id });

  // A fresh report that offers it again applies the remembered level without a new choice.
  await rm(join(agents.piRpcHome, "levels.json"));
  await api.sessions.restart({ id: session.id, size: SIZE });
  const restored = follow(api, session.id);
  try {
    await restored.until(
      (view) => view.state.reasoning === "max" && view.state.selectionIssue === null,
      "the level used again",
    );
  } finally {
    await restored.close();
  }
});

test("a failed level report leaves the choice unconfirmed rather than removed", async () => {
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  const { api, session } = await chatTask("Stale level");
  const first = follow(api, session.id);
  try {
    await first.until((view) => view.state.turn === "settled", "the settled turn");
    await api.chat.setModel({
      sessionId: session.id,
      model: { provider: "stub", id: "stub-2" },
      level: "max",
    });
    await first.until((view) => view.state.reasoning === "max", "the applied level");
  } finally {
    await first.close();
  }
  await api.sessions.stop({ id: session.id });

  vi.stubEnv("FAKE_PI_RPC", "refresh-fail");
  await api.sessions.restart({ id: session.id, size: SIZE });
  const resumed = follow(api, session.id);
  try {
    await resumed.until(
      (view) => view.state.selectionIssue?.reason === "unconfirmed",
      "the unconfirmed level",
    );
    expect(resumed.state.reasoningStatus).toBe("error");
    expect(resumed.state.selection?.level).toBe("max");
    await expect(
      api.chat.send({ sessionId: session.id, text: "must not leave", mode: "prompt" }),
    ).rejects.toMatchObject({ code: "CHAT_REASONING_UNSUPPORTED" });
  } finally {
    await resumed.close();
  }
  await api.sessions.stop({ id: session.id });

  // The failure was not evidence of removal: a fresh report restores the same level.
  vi.stubEnv("FAKE_PI_RPC", "normal");
  await api.sessions.restart({ id: session.id, size: SIZE });
  const restored = follow(api, session.id);
  try {
    await restored.until(
      (view) => view.state.reasoning === "max" && view.state.selectionIssue === null,
      "the level used again",
    );
  } finally {
    await restored.close();
  }
});

test("a level chosen during a turn is refused when the live report does not offer it", async () => {
  // The launch's fresh catalog already lacks `high` on stub-1.
  await mkdir(agents.piRpcHome, { recursive: true });
  await writeFile(
    join(agents.piRpcHome, "levels.json"),
    JSON.stringify({ "stub-1": ["off", "low", "medium"] }),
  );
  vi.stubEnv("FAKE_PI_RPC", "slow");
  vi.stubEnv("FAKE_PI_RPC_DELAY_MS", "800");
  vi.stubEnv("FAKE_PI_RPC_DIALOG", "none");
  const { api, session } = await chatTask("Running turn");
  const agentSessionId = session.agentSessionId!;
  const chat = follow(api, session.id);
  try {
    await chat.until(
      (view) => view.state.turn === "working" && view.state.reasoningLevels.length > 0,
      "the running turn",
    );
    await expect(
      api.chat.setReasoning({ sessionId: session.id, level: "high" }),
    ).rejects.toMatchObject({ code: "CHAT_REASONING_UNSUPPORTED" });
    await chat.until(
      (view) =>
        view.state.selection?.level === "high" &&
        view.state.selectionIssue?.reason === "unavailable",
      "the stored choice with its issue",
    );
    // A follow-up carrying it is refused instead of queued and later run on another level.
    await expect(
      api.chat.send({ sessionId: session.id, text: "must not queue", mode: "follow-up" }),
    ).rejects.toMatchObject({ code: "CHAT_REASONING_UNSUPPORTED" });
    expect(chat.state.queue?.some((entry) => entry.text === "must not queue")).toBe(false);
    expect(chat.state.reasoning).not.toBe("high");
    expect((await piCommands(agentSessionId)).filter((entry) => entry.level === "high")).toEqual(
      [],
    );
  } finally {
    await chat.close();
    await rm(join(agents.piRpcHome, "levels.json"), { force: true });
    vi.stubEnv("FAKE_PI_RPC", "normal");
  }
});

test("an idle chat session hands over to a terminal and back with its id, label, tab place and history", async () => {
  const { api, session } = await chatTask("Remember the note");
  await settleTurn(api, session.id, "Remember the note");
  const labelled = await api.sessions.setLabel({ id: session.id, label: "Notes" });
  expect(labelled.label).toBe("Notes");
  const [chatLaunch] = await agents.launches();
  expect(processExists(chatLaunch!.pid)).toBe(true);
  const tabs = (await sessionsOf(api)).map((candidate) => candidate.id);

  // chat → terminal: the chat child goes first, then pi's TUI opens on the same agent session.
  const handed = await api.sessions.setView({ id: session.id, view: "terminal", size: SIZE });
  expect(handed).toMatchObject({
    id: session.id,
    kind: "pi",
    view: "terminal",
    state: "running",
    label: "Notes",
    agentSessionId: session.agentSessionId,
    terminalId: expect.any(String),
  });
  // No second frontend ever existed: the chat child is gone by the time the terminal is recorded.
  const [, terminalLaunch] = await piLaunches(2);
  expect(processExists(chatLaunch!.pid)).toBe(false);
  expect(await piArgv()).toEqual([
    ["--mode", "rpc", "--session-id", session.agentSessionId],
    ["--session-id", session.agentSessionId],
  ]);
  expect(processExists(terminalLaunch!.pid)).toBe(true);
  // The same row, in the same place of the task's tabs.
  expect((await sessionsOf(api)).map((candidate) => candidate.id)).toEqual(tabs);
  // The chat procedures agree with the row: this session is a terminal now.
  await expect(firstMessage(api.chat.watch({ sessionId: session.id }))).rejects.toMatchObject({
    code: "CHAT_UNAVAILABLE",
    data: { reason: "no-driver" },
  });
  const screen = await server.attach(handed.terminalId!);
  await screen.waitForScreen("fake pi ready");

  // terminal → chat: the chat is rebuilt from pi's own history, and nothing is prompted again.
  const back = await api.sessions.setView({ id: session.id, view: "chat", size: SIZE });
  expect(back).toMatchObject({
    id: session.id,
    view: "chat",
    state: "running",
    label: "Notes",
    agentSessionId: session.agentSessionId,
    terminalId: null,
  });
  expect(processExists(terminalLaunch!.pid)).toBe(false);
  const rebuilt = follow(api, session.id);
  try {
    await rebuilt.until(
      (view) => view.itemOfKind("tool-call")?.status === "done",
      "the rebuilt history",
    );
    expect(rebuilt.itemOfKind("user-message")).toMatchObject({ text: "Remember the note" });
    expect(rebuilt.itemOfKind("assistant-message")).toMatchObject({
      text: "Here is the answer.",
      streaming: false,
    });
    expect(rebuilt.itemOfKind("tool-call")).toMatchObject({ diff: { path: "notes.txt" } });
  } finally {
    await rebuilt.close();
  }
  await piLaunches(3);
  expect(await piArgv()).toEqual([
    ["--mode", "rpc", "--session-id", session.agentSessionId],
    ["--session-id", session.agentSessionId],
    ["--mode", "rpc", "--session-id", session.agentSessionId],
  ]);
  // pi's history holds the prompt once: a resumed frontend does not hand it over again.
  expect(userMessages(await journalOf(session.agentSessionId!))).toEqual(["Remember the note"]);
  // No frontend ever found its predecessor alive, in any of the three switches.
  expect(existsSync(overlapMarker(session.agentSessionId!))).toBe(false);
});

test("a handoff while the turn runs aborts it first, so the conversation keeps the aborted turn", async () => {
  // Long enough that the turn is still running when the handoff arrives, short enough that pi
  // reports the aborted turn before the stop's grace runs out.
  vi.stubEnv("FAKE_PI_RPC", "slow");
  vi.stubEnv("FAKE_PI_RPC_DELAY_MS", "150");
  const { api, session } = await chatTask("Change the note");
  const [chatLaunch] = await piLaunches(1);
  const chat = follow(api, session.id);
  try {
    await chat.until((view) => view.state.turn === "working", "the running turn");

    // The handoff aborts the turn before the child goes, and waits for pi to report it ended.
    const handed = await api.sessions.setView({ id: session.id, view: "terminal", size: SIZE });
    expect(handed).toMatchObject({ view: "terminal", state: "running" });
    expect(processExists(chatLaunch!.pid)).toBe(false);
    // What the agent had written stays in its own history, marked as the abort it was.
    const journal = await journalOf(session.agentSessionId!);
    expect(userMessages(journal)).toEqual(["Change the note"]);
    expect(journal.find((message) => message["role"] === "assistant")).toMatchObject({
      stopReason: "aborted",
    });
    await piLaunches(2);
    expect(await piArgv()).toEqual([
      ["--mode", "rpc", "--session-id", session.agentSessionId],
      ["--session-id", session.agentSessionId],
    ]);
    expect(existsSync(overlapMarker(session.agentSessionId!))).toBe(false);
    // A watching chat client saw the turn end, not a stream that stopped mid-word.
    await chat.until((view) => view.state.turn !== "working", "the ended turn");
    expect(chat.state.turn).toBe("aborted");
  } finally {
    await chat.close();
  }
});

test("a stop during a turn aborts it and keeps what the agent wrote in its history", async () => {
  // The turn is running when the stop arrives, and short enough to report the abort within the
  // stop's grace, exactly as the handoff's own abort expects.
  vi.stubEnv("FAKE_PI_RPC", "slow");
  vi.stubEnv("FAKE_PI_RPC_DELAY_MS", "150");
  const { api, task, session } = await chatTask("Keep the note");
  const [launch] = await piLaunches(1);
  await waitForStatus(api, session.id, "working");

  const stopped = await api.sessions.stop({ id: session.id });

  expect(stopped).toMatchObject({ id: session.id, state: "stopped", terminalId: null });
  await expect
    .poll(() => processExists(launch!.pid), { timeout: 10_000, message: "the child" })
    .toBe(false);
  // The agent recorded the turn it was writing, marked as the abort it was.
  const journal = await journalOf(session.agentSessionId!);
  expect(userMessages(journal)).toEqual(["Keep the note"]);
  expect(journal.find((message) => message["role"] === "assistant")).toMatchObject({
    stopReason: "aborted",
  });
  // Stopping the session is not settling the task.
  expect(await taskStateOf(api, task.id)).toBe("active");
});

test("a handoff whose second start fails leaves the session stopped in the target view, and retries", async () => {
  const { api, session } = await chatTask("Keep it");
  await settleTurn(api, session.id, "Keep it");
  const [chatLaunch] = await agents.launches();
  const path = process.env["PATH"];

  // Nothing the server can start: the handoff's second launch fails after the first frontend is gone.
  vi.stubEnv("PATH", "/nonexistent");
  await expect(
    api.sessions.setView({ id: session.id, view: "terminal", size: SIZE }),
  ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND", data: { command: "pi" } });
  expect(processExists(chatLaunch!.pid)).toBe(false);
  const stopped = (await sessionsOf(api)).find((candidate) => candidate.id === session.id);
  expect(stopped).toMatchObject({
    state: "stopped",
    view: "terminal",
    terminalId: null,
    agentSessionId: session.agentSessionId,
  });
  expect(stopped?.launchError).toBe("pi is not on the server's PATH");
  // Nothing was left running on the session, and no second process was started for it.
  expect(await agents.launches()).toHaveLength(1);
  expect(existsSync(overlapMarker(session.agentSessionId!))).toBe(false);

  // A stopped session only records the view its next start opens in: that is the retry in either
  // view, without a process to stop.
  const flipped = await api.sessions.setView({ id: session.id, view: "chat", size: SIZE });
  expect(flipped).toMatchObject({
    state: "stopped",
    view: "chat",
    launchError: expect.any(String),
  });
  expect(await agents.launches()).toHaveLength(1);

  // With the agent back, `restart` is the retry and opens the view the session holds.
  vi.stubEnv("PATH", path ?? "");
  const restarted = await api.sessions.restart({ id: session.id, size: SIZE });
  expect(restarted).toMatchObject({ view: "chat", state: "running", launchError: null });
  await piLaunches(2);
  expect(await piArgv()).toEqual([
    ["--mode", "rpc", "--session-id", session.agentSessionId],
    ["--mode", "rpc", "--session-id", session.agentSessionId],
  ]);
  // The retry resumes the conversation the first frontend wrote; nothing prompts it again.
  const rebuilt = follow(api, session.id);
  try {
    await rebuilt.until(
      (view) => view.itemOfKind("assistant-message") !== undefined,
      "the rebuilt history",
    );
    expect(rebuilt.itemOfKind("user-message")).toMatchObject({ text: "Keep it" });
  } finally {
    await rebuilt.close();
  }
});

test("setView refuses a shell, and a switch to the current view does nothing", async () => {
  const { api, task, session } = await chatTask("Same view");
  // The first fake process must be counted before the call, or a restart would pass unnoticed.
  const [started] = await piLaunches(1);
  await expect(
    api.sessions.setView({ id: session.id, view: "chat", size: SIZE }),
  ).resolves.toMatchObject({ id: session.id, view: "chat", state: "running" });
  // The same frontend, still alive: no stop and no second spawn for the view it already has.
  expect(processExists(started!.pid)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(await agents.launches()).toHaveLength(1);
  expect(existsSync(overlapMarker(session.agentSessionId!))).toBe(false);

  const shell = await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });
  await expect(
    api.sessions.setView({ id: shell.id, view: "chat", size: SIZE }),
  ).rejects.toMatchObject({
    code: "LAUNCH_VIEW_UNSUPPORTED",
    data: { kind: "shell", view: "chat" },
  });
  // Every shipped agent has a driver; a shell is the only kind that cannot show chat.
  await expect(
    api.sessions.setView({ id: "nope", view: "chat", size: SIZE }),
  ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  // The refusal touched no process: the shell session still runs in its terminal.
  expect((await sessionsOf(api)).find((each) => each.id === shell.id)?.state).toBe("running");
});

test("a terminal launch stops a chat frontend's recorded writer before it spawns", async () => {
  const { api, session } = await chatTask("Stale writer");
  await settleTurn(api, session.id, "Stale writer");
  // Move the session to its terminal view, then stop it: the live frontend is gone but the terminal
  // launch is the one that will run next.
  await api.sessions.setView({ id: session.id, view: "terminal", size: SIZE });
  // The terminal fake announces itself at start; waiting for it keeps the stop below from closing
  // the PTY before the launch was ever recorded.
  await piLaunches(2);
  await api.sessions.stop({ id: session.id });
  const launchesBefore = (await agents.launches()).length;

  // A record a previous server could have left behind: its pid is alive and is the writer the
  // record names, so a launch that ignored it would write the same pi session beside a live process.
  const stale = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
  const claimPath = writerPath(join(server.dataDir, "chat"), session.id);
  recordWriter(claimPath, stale.pid!);
  try {
    const restarted = await api.sessions.restart({ id: session.id, size: SIZE });
    expect(restarted).toMatchObject({ state: "running", view: "terminal" });
  } finally {
    try {
      process.kill(-stale.pid!, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  expect(processExists(stale.pid!)).toBe(false);
  // The terminal launch never records a writer of its own, so the record is gone, not replaced.
  expect(existsSync(claimPath)).toBe(false);
  // The PTY announces itself after `restart` returns; the point is that it is the next launch.
  await piLaunches(launchesBefore + 1);
}, 20_000);

test("a failed handoff clears the working status it interrupted, so the task does not stay working", async () => {
  // A turn that is genuinely working (and never settles) when the handoff fails: the row becomes
  // stopped, and a status left over from the killed frontend would keep the task in "Working".
  vi.stubEnv("FAKE_PI_RPC", "stuck-abort");
  const { api, session } = await chatTask("Interrupted");
  await waitForStatus(api, session.id, "working");
  await piLaunches(1);
  const path = process.env["PATH"];

  vi.stubEnv("PATH", "/nonexistent");
  try {
    await expect(
      api.sessions.setView({ id: session.id, view: "terminal", size: SIZE }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
  } finally {
    vi.stubEnv("PATH", path ?? "");
  }
  const stopped = (await sessionsOf(api)).find((each) => each.id === session.id);
  expect(stopped).toMatchObject({
    state: "stopped",
    view: "terminal",
    terminalId: null,
    launchError: "pi is not on the server's PATH",
  });
  // `working` does not outlive its program, so nothing is left reporting it.
  expect(stopped?.status).toBeNull();
}, 20_000);

test("a failed handoff into chat fails asynchronously and leaves the session stopped and settled", async () => {
  const { api, task } = await addTask(server, "Terminal first");
  const terminal = await api.sessions.start({ taskId: task.id, kind: "pi", size: SIZE });
  expect(terminal).toMatchObject({ view: "terminal", state: "running" });
  const [terminalLaunch] = await piLaunches(1);
  expect(terminalLaunch!.argv).not.toContain("--mode");

  // `silent`: the child spawns and never answers a start-up command, so the ready deadline is what
  // fails it — the asynchronous second-start failure, unlike the PATH case above.
  vi.stubEnv("FAKE_PI_RPC", "silent");
  const handed = await api.sessions.setView({ id: terminal.id, view: "chat", size: SIZE });
  expect(handed).toMatchObject({ view: "chat", state: "running", terminalId: null });

  await expect
    .poll(async () => (await sessionsOf(api)).find((each) => each.id === terminal.id), {
      timeout: 10_000,
      message: "the failed chat frontend",
    })
    .toMatchObject({
      state: "stopped",
      view: "chat",
      launchError: expect.stringContaining("did not answer"),
    });
  const failed = (await sessionsOf(api)).find((each) => each.id === terminal.id);
  // A stopped session must not keep the task in "working" through a stale status.
  expect(failed?.status?.state).not.toBe("working");
  expect(processExists(terminalLaunch!.pid)).toBe(false);
  expect(await agents.launches()).toHaveLength(2);
  expect(existsSync(overlapMarker(terminal.agentSessionId!))).toBe(false);
});

test("a pi that never answers abort cannot hold the session queue: handoff then queued stop both finish", async () => {
  vi.stubEnv("FAKE_PI_RPC", "stuck-abort");
  const { api, session } = await chatTask("Ignored abort");
  const [chatLaunch] = await piLaunches(1);
  await waitForStatus(api, session.id, "working");

  // Both issued in one tick: the stop queues behind the handoff, as a user's `prefix x` would.
  // The 15 s deadline is what proves the queue is not parked; the measured latency for this child
  // is one grace (441 ms with `exitGraceMs: 400`, measured in review), not the deadline.
  const handed = within(
    api.sessions.setView({ id: session.id, view: "terminal", size: SIZE }),
    "the handoff to a pi that ignores abort",
  );
  const stopped = within(api.sessions.stop({ id: session.id }), "the queued stop");
  await expect(handed).resolves.toMatchObject({ view: "terminal" });
  await expect(stopped).resolves.toMatchObject({ state: "stopped" });
  // The queued stop may close the terminal before its fake even logs its launch, so the count is
  // not the claim here: both calls finished, the session settled, and no frontend overlapped.
  expect((await sessionsOf(api)).find((each) => each.id === session.id)?.state).toBe("stopped");
  expect(processExists(chatLaunch!.pid)).toBe(false);
  expect(existsSync(overlapMarker(session.agentSessionId!))).toBe(false);
}, 20_000);

test("a handoff to a pi that never answers abort does not block the server's shutdown", async () => {
  vi.stubEnv("FAKE_PI_RPC", "stuck-abort");
  const { api, session } = await chatTask("Ignored abort again");
  await waitForStatus(api, session.id, "working");
  // The handoff is in flight (its abort is the only thing that could park the queue) when the
  // server is asked to shut down; the RPC itself may die with the socket, so only restart's own
  // completion is asserted. The fake marks the abort it is ignoring, which is the moment to ask.
  const handed = api.sessions
    .setView({ id: session.id, view: "terminal", size: SIZE })
    .catch(() => undefined);
  const abortSeen = join(agents.piRpcHome, `${session.agentSessionId!}.abort-seen`);
  await expect
    .poll(() => existsSync(abortSeen), { timeout: 10_000, message: "the ignored abort" })
    .toBe(true);
  await within(server.restart(), "the server restart behind a stuck handoff");
  await handed;
  // The handoff completed before the shutdown, so the restore opens the view it recorded.
  const restarted = await server.rpc();
  await expect
    .poll(async () => (await sessionsOf(restarted)).find((each) => each.id === session.id)?.view, {
      timeout: 10_000,
      message: "the restored view",
    })
    .toBe("terminal");
}, 20_000);

test("a chat task's native model reaches pi's RPC argv, not just the terminal's", async () => {
  // The chat argv moved out of the session service into the driver (C0): the model a profile or
  // the user chose must still be a pi flag before `--session-id`, as a terminal launch passes it.
  const { project } = await addProject(server, "chat argv");
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "Check the model flag",
    agent: { kind: "pi", view: "chat", model: "stub-2" },
    workspace: { type: "main-worktree" },
  });
  const session = (await sessionsOf(api)).find(
    (candidate) => candidate.id === task.primarySessionId,
  )!;
  const [launch] = await piLaunches(1);
  expect(launch!.argv).toEqual([
    "--mode",
    "rpc",
    "--model",
    "stub-2",
    "--session-id",
    session.agentSessionId,
  ]);
});
