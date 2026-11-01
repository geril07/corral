import type {
  ChatEvent,
  ChatItem,
  ChatSessionState,
  ChatStreamMessage,
} from "@corral/protocol/chat";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { floorPath } from "./sequence-floor.ts";
import { recordWriter, writerPath } from "./writer-claim.ts";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { addProject, addTask } from "../../test/project-fixture.ts";
import { useServer, within } from "../../test/server-fixture.ts";
import { launchesOf, processExists, sessionsOf } from "../../test/session-helpers.ts";

const server = useServer({
  chat: { dialogTimeoutMs: 600, readyTimeoutMs: 1200, exitGraceMs: 400, writerWaitMs: 2000 },
});
const agents = useFakeAgents();
const SIZE = { cols: 80, rows: 24 };

type Api = Awaited<ReturnType<typeof server.rpc>>;

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
    steering: [],
    followUp: [],
    model: null,
    models: [],
    reasoning: null,
    reasoningLevels: [],
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
  expect(await api.chat.capabilities()).toEqual({ drivers: ["pi"] });

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

test("a crash ends the frontend with a visible reason and the session stays resumable", async () => {
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

  // Continuing starts a new frontend; the crashed turn never wrote history, so the prompt goes again.
  vi.stubEnv("FAKE_PI_RPC", "normal");
  const restarted = await api.sessions.restart({ id: session.id, size: SIZE });
  expect(restarted).toMatchObject({ state: "running", view: "chat", terminalId: null });
  const again = follow(api, session.id);
  try {
    await again.until((view) => view.itemOfKind("user-request") !== undefined, "the next turn");
    expect(again.itemOfKind("user-message")).toMatchObject({ text: "Add a note to notes.txt" });
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

test("settling the task stops the chat child; making it active again resumes with its history", async () => {
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
  await expect
    .poll(async () => processExists(launch!.pid), { timeout: 10_000, message: "the stopped child" })
    .toBe(false);
  expect((await sessionsOf(api)).find((candidate) => candidate.id === session.id)?.state).toBe(
    "stopped",
  );
  await expect(firstMessage(api.chat.watch({ sessionId: session.id }))).rejects.toMatchObject({
    code: "CHAT_UNAVAILABLE",
    data: { reason: "not-started" },
  });

  await api.tasks.setState({ id: task.id, state: "active" });
  await expect
    .poll(async () => (await agents.launches()).length, { timeout: 10_000, message: "the resume" })
    .toBe(2);
  const launches = await agents.launches();
  expect(launches[1]!.argv).toEqual(["--mode", "rpc", "--session-id", session.agentSessionId]);
  const chat = follow(api, session.id);
  try {
    await chat.until(
      (view) => view.itemOfKind("tool-call")?.status === "done",
      "the rebuilt history",
    );
    expect(chat.itemOfKind("user-message")).toMatchObject({ text: "Keep it" });
  } finally {
    await chat.close();
  }
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
  await expect(
    api.sessions.start({ taskId: task.id, kind: "claude", view: "chat", size: SIZE }),
  ).rejects.toMatchObject({
    code: "LAUNCH_VIEW_UNSUPPORTED",
    data: { kind: "claude", view: "chat" },
  });

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

    await api.chat.setModel({ sessionId: session.id, model: { provider: "stub", id: "stub-2" } });
    await chat.until((view) => view.state.model?.id === "stub-2", "the new model");
    await api.chat.setReasoning({ sessionId: session.id, level: "high" });
    await chat.until((view) => view.state.reasoning === "high", "the new reasoning level");

    await expect(
      api.chat.setModel({ sessionId: session.id, model: { provider: "stub", id: "stub-9" } }),
    ).rejects.toMatchObject({ code: "CHAT_MODEL_UNSUPPORTED" });
  } finally {
    await chat.close();
  }
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
    expect(chat.itemOfKind("error")).toBeUndefined();
  } finally {
    await chat.close();
  }
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

test("setView refuses a shell and an agent without a driver, and a switch to the current view does nothing", async () => {
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
  const claude = await api.sessions.start({ taskId: task.id, kind: "claude", size: SIZE });
  await expect(
    api.sessions.setView({ id: claude.id, view: "chat", size: SIZE }),
  ).rejects.toMatchObject({
    code: "LAUNCH_VIEW_UNSUPPORTED",
    data: { kind: "claude", view: "chat" },
  });
  await expect(
    api.sessions.setView({ id: "nope", view: "chat", size: SIZE }),
  ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  // Neither refusal touched a process: the shell and claude sessions still run in their terminals.
  expect((await sessionsOf(api)).find((each) => each.id === shell.id)?.state).toBe("running");
  expect((await sessionsOf(api)).find((each) => each.id === claude.id)?.state).toBe("running");
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
});

test("a pi that never answers abort cannot hold the session queue: handoff then queued stop both finish", async () => {
  vi.stubEnv("FAKE_PI_RPC", "stuck-abort");
  const { api, session } = await chatTask("Ignored abort");
  const [chatLaunch] = await piLaunches(1);
  await waitForStatus(api, session.id, "working");

  // Both issued in one tick: the stop queues behind the handoff, as a user's `prefix x` would.
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
