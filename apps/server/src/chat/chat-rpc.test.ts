import type {
  ChatEvent,
  ChatItem,
  ChatSessionState,
  ChatStreamMessage,
} from "@corral/protocol/chat";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { addProject } from "../../test/project-fixture.ts";
import { useServer, within } from "../../test/server-fixture.ts";
import { processExists, sessionsOf } from "../../test/session-helpers.ts";

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
