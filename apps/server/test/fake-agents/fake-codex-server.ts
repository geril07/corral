// A stand-in for `codex app-server --listen unix://PATH` (0.166.0), speaking the v2 subset the
// chat driver needs. Measured facts it reproduces (`.e2e/stage-c/c3/probe/`):
//
// - the unix listener is a WebSocket endpoint (`ws+unix://…`), not newline JSON-RPC;
// - `thread/start` assigns the id; `thread/resume` of an id with no stored turn fails with
//   `no rollout found for thread id …`; `thread/resume` on a connection subscribes it to the
//   thread's notifications, and `turn/start` on an unsubscribed connection sends none;
// - `turn/start` echoes the user message with `clientId` = the caller's `clientUserMessageId`;
// - an approval is a server-initiated JSON-RPC request (`item/commandExecution/requestApproval`)
//   sent to every attached client, and one `result` answers it for all of them
//   (`serverRequest/resolved`).
//
// A prompt controls what happens, so a test reads like the user's words:
//   SLOW  → stream with gaps, long enough to steer and interrupt;
//   APPROVE → ask for a command approval before finishing;
//   FAIL  → the turn fails;
//   CRASH → the server dies as if it were killed.
import { appendFileSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

interface ThreadRecord {
  id: string;
  cwd: string;
  preview: string;
  ephemeral: boolean;
  createdAt: number;
  recencyAt: number;
  turns: TurnRecord[];
}

interface TurnRecord {
  id: string;
  status: "inProgress" | "completed" | "interrupted" | "failed";
  items: ItemRecord[];
  error?: { message: string };
}

type ItemRecord = Record<string, unknown> & { id: string; type: string };

export interface FakeCodexServerOptions {
  socketPath: string;
  /** Where threads are written so a restarted fake server still has them; in-memory when absent. */
  journal?: string;
  /** Prefix for generated ids, so a test can tell two servers apart. */
  idPrefix?: string;
}

export interface FakeCodexServer {
  /** Every frame both ways, for assertions a client cannot make. */
  readonly frames: { at: number; dir: "send" | "recv"; frame: unknown }[];
  close(): Promise<void>;
}

let counter = 0;
/** JSON-RPC ids of the fake server's own requests: the real one numbers them from 0. */
let requestCounter = 0;

/** Starts the fake server; resolves once the socket accepts connections. */
export async function startFakeCodexServer(
  options: FakeCodexServerOptions,
): Promise<FakeCodexServer> {
  const frames: FakeCodexServer["frames"] = [];
  const prefix = options.idPrefix ?? "thr";
  const threads = loadThreads(options.journal);
  const clients = new Set<WebSocket>();
  const pendingApprovals = new Map<
    string,
    { turn: TurnRecord; thread: ThreadRecord; decide: (decision: string) => void }
  >();
  const http = createServer((_request, response) => response.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true });

  const record = (dir: "send" | "recv", frame: unknown) => {
    frames.push({ at: Date.now(), dir, frame });
  };
  const send = (socket: WebSocket, frame: unknown) => {
    if (socket.readyState !== socket.OPEN) return;
    record("send", frame);
    socket.send(JSON.stringify(frame));
  };
  const broadcast = (frame: unknown) => {
    for (const socket of clients) send(socket, frame);
  };
  const notify = (method: string, params: unknown) =>
    broadcast({ method, params, emittedAtMs: Date.now() });

  http.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    wss.handleUpgrade(request, socket, head, (websocket) => {
      clients.add(websocket);
      const subscribed = new Set<string>();
      websocket.on("message", (data) => onFrame(websocket, subscribed, rawText(data)));
      websocket.on("close", () => clients.delete(websocket));
    });
  });

  function saved(thread: ThreadRecord): void {
    if (options.journal === undefined) return;
    appendFileSync(
      options.journal,
      `${JSON.stringify({ thread: { id: thread.id, cwd: thread.cwd, preview: thread.preview, turns: thread.turns } })}\n`,
    );
  }

  function threadOf(id: string): ThreadRecord | undefined {
    return threads.get(id);
  }

  function publicThread(thread: ThreadRecord, includeTurns = true): Record<string, unknown> {
    return {
      id: thread.id,
      sessionId: thread.id,
      cwd: thread.cwd,
      ephemeral: thread.ephemeral,
      preview: thread.preview,
      modelProvider: "stub",
      model: "stub-model",
      historyMode: "paginated",
      status: { type: "idle" },
      createdAt: Math.floor(thread.createdAt / 1000),
      updatedAt: Math.floor(thread.createdAt / 1000),
      recencyAt: Math.floor(thread.recencyAt / 1000),
      cliVersion: "0.166.0",
      source: "corral",
      turns: includeTurns ? thread.turns.map(publicTurn) : [],
    };
  }

  function publicTurn(turn: TurnRecord): Record<string, unknown> {
    return {
      id: turn.id,
      rootTurnId: turn.id,
      status: turn.status,
      items: turn.items,
      itemsView: "full",
      error: turn.error ?? null,
    };
  }

  function onFrame(socket: WebSocket, subscribed: Set<string>, text: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    record("recv", frame);
    const method = frame["method"];
    if (typeof method !== "string") {
      answerServerRequest(String(frame["id"]), frame["result"]);
      return;
    }
    const id = frame["id"];
    const params = (frame["params"] ?? {}) as Record<string, unknown>;
    const respond = (result: unknown) => send(socket, { id, result });
    const fail = (message: string) => send(socket, { id, error: { code: -32600, message } });
    switch (method) {
      case "initialize":
        respond({
          userAgent: "fake-codex/0.166.0",
          codexHome: "/tmp/fake",
          platformFamily: "unix",
          platformOs: "linux",
        });
        return;
      case "thread/start": {
        const thread = newThread(stringOf(params["cwd"]) ?? "/tmp", prefix);
        threads.set(thread.id, thread);
        saved(thread);
        subscribed.add(thread.id);
        respond({
          thread: publicThread(thread),
          model: "stub-model",
          modelProvider: "stub",
          approvalPolicy: "on-request",
          sandbox: { type: "workspaceWrite" },
        });
        notify("thread/started", { thread: publicThread(thread, false) });
        return;
      }
      case "thread/list": {
        const data = [...threads.values()]
          .toSorted((left, right) => right.recencyAt - left.recencyAt)
          .map((thread) => publicThread(thread, false));
        respond({ data });
        return;
      }
      case "thread/resume": {
        const thread = threadOf(String(params["threadId"]));
        if (thread === undefined) {
          fail(`no rollout found for thread id ${String(params["threadId"])}`);
          return;
        }
        subscribed.add(thread.id);
        respond({
          thread: publicThread(thread),
          model: "stub-model",
          modelProvider: "stub",
          approvalPolicy: "on-request",
          sandbox: { type: "workspaceWrite" },
        });
        return;
      }
      case "thread/read": {
        const thread = threadOf(String(params["threadId"]));
        if (thread === undefined) {
          fail(`no rollout found for thread id ${String(params["threadId"])}`);
          return;
        }
        respond({ thread: publicThread(thread) });
        return;
      }
      case "turn/start": {
        const thread = threadOf(String(params["threadId"]));
        if (thread === undefined) {
          fail(`thread not found: ${String(params["threadId"])}`);
          return;
        }
        const prompt = inputText(params);
        const turn = newTurn();
        thread.turns.push(turn);
        thread.recencyAt = Date.now();
        respond({ turn: publicTurn(turn) });
        if (!subscribed.has(thread.id)) return;
        void runTurn(socket, thread, turn, prompt, stringOf(params["clientUserMessageId"]) ?? "");
        return;
      }
      case "turn/steer": {
        const thread = threadOf(String(params["threadId"]));
        const turn = thread?.turns.find((each) => each.id === String(params["expectedTurnId"]));
        if (thread === undefined || turn === undefined || turn.status !== "inProgress") {
          fail("no active turn to steer");
          return;
        }
        const text = inputText(params);
        const item = userItem(
          text,
          `steer-${itemCounter()}`,
          stringOf(params["clientUserMessageId"]) ?? "",
        );
        turn.items.push(item);
        notify("item/started", {
          item,
          threadId: thread.id,
          turnId: turn.id,
          startedAtMs: Date.now(),
        });
        notify("item/completed", {
          item,
          threadId: thread.id,
          turnId: turn.id,
          completedAtMs: Date.now(),
        });
        respond({ turnId: turn.id });
        return;
      }
      case "thread/queue/add": {
        const thread = threadOf(String(params["threadId"]));
        if (thread === undefined) {
          fail(`thread not found: ${String(params["threadId"])}`);
          return;
        }
        const text = inputText(params);
        queued.set(thread.id, [...(queued.get(thread.id) ?? []), text]);
        notify("thread/queue/changed", { threadId: thread.id });
        respond({});
        return;
      }
      case "turn/interrupt": {
        const thread = threadOf(String(params["threadId"]));
        const turn = thread?.turns.find((each) => each.id === String(params["turnId"]));
        if (turn !== undefined && turn.status === "inProgress") {
          turn.status = "interrupted";
          notify("turn/completed", {
            threadId: thread!.id,
            turn: publicTurn(turn),
          });
        }
        respond({});
        return;
      }
      default:
        fail(`unknown method ${method}`);
    }
  }

  /** One answer per approval, whichever client sent it first; everyone hears the resolution. */
  function answerServerRequest(requestId: string, result: unknown): void {
    const pending = pendingApprovals.get(requestId);
    if (pending === undefined) return;
    pendingApprovals.delete(requestId);
    const decision =
      typeof result === "object" && result !== null
        ? (stringOf((result as Record<string, unknown>)["decision"]) ?? "decline")
        : "decline";
    pending.decide(decision);
  }

  const queued = new Map<string, string[]>();

  async function runTurn(
    socket: WebSocket,
    thread: ThreadRecord,
    turn: TurnRecord,
    text: string,
    clientUserMessageId: string,
  ): Promise<void> {
    notify("thread/status/changed", {
      threadId: thread.id,
      status: { type: "active", activeFlags: [] },
    });
    notify("turn/started", { threadId: thread.id, turn: publicTurn(turn) });
    const user = userItem(text, `usr-${itemCounter()}`, clientUserMessageId);
    turn.items.push(user);
    notify("item/started", {
      item: user,
      threadId: thread.id,
      turnId: turn.id,
      startedAtMs: Date.now(),
    });
    notify("item/completed", {
      item: user,
      threadId: thread.id,
      turnId: turn.id,
      completedAtMs: Date.now(),
    });

    if (text.includes("CRASH")) {
      // A server that dies mid-turn: the WebSocket closes without a turn/completed.
      for (const each of clients) each.terminate();
      await close();
      return;
    }
    if (text.includes("FAIL")) {
      turn.status = "failed";
      turn.error = { message: "the stub turn failed" };
      notify("error", {
        threadId: thread.id,
        turnId: turn.id,
        error: { message: "the stub turn failed" },
        willRetry: false,
      });
      notify("thread/status/changed", { threadId: thread.id, status: { type: "idle" } });
      notify("turn/completed", { threadId: thread.id, turn: publicTurn(turn) });
      return;
    }
    if (text.includes("APPROVE")) {
      const approval = await askApproval(thread, turn);
      if (approval !== "accept" && approval !== "acceptForSession") {
        addCommand(thread, turn, "touch approved.txt", "denied");
        turn.status = "completed";
        finishTurn(thread, turn);
        return;
      }
      addCommand(thread, turn, "touch approved.txt", "completed");
    }

    const messageId = `msg-${itemCounter()}`;
    const message: ItemRecord = { id: messageId, type: "agentMessage", text: "", phase: null };
    turn.items.push(message);
    notify("item/started", {
      item: message,
      threadId: thread.id,
      turnId: turn.id,
      startedAtMs: Date.now(),
    });
    const chunks = text.includes("SLOW")
      ? Array.from({ length: 20 }, (_, index) => `part ${index} `)
      : ["the stub ", "answer"];
    let body = "";
    for (const chunk of chunks) {
      if (turn.status !== "inProgress") break;
      body += chunk;
      notify("item/agentMessage/delta", {
        threadId: thread.id,
        turnId: turn.id,
        itemId: messageId,
        delta: chunk,
      });
      if (text.includes("SLOW")) {
        // oxlint-disable-next-line no-await-in-loop -- a slow stream is the point
        await delay(100);
      }
    }
    message["text"] = body;
    notify("item/completed", {
      item: message,
      threadId: thread.id,
      turnId: turn.id,
      completedAtMs: Date.now(),
    });
    turn.status = turn.status === "inProgress" ? "completed" : turn.status;
    finishTurn(thread, turn, socket);
  }

  function addCommand(
    thread: ThreadRecord,
    turn: TurnRecord,
    command: string,
    status: string,
  ): void {
    const item: ItemRecord = {
      id: `cmd-${itemCounter()}`,
      type: "commandExecution",
      command,
      commandActions: [],
      cwd: thread.cwd,
      status,
      aggregatedOutput: status === "completed" ? "" : null,
    };
    turn.items.push(item);
    notify("item/started", { item, threadId: thread.id, turnId: turn.id, startedAtMs: Date.now() });
    notify("item/completed", {
      item,
      threadId: thread.id,
      turnId: turn.id,
      completedAtMs: Date.now(),
    });
  }

  function finishTurn(thread: ThreadRecord, turn: TurnRecord, socket?: WebSocket): void {
    saved(thread);
    notify("thread/status/changed", { threadId: thread.id, status: { type: "idle" } });
    notify("turn/completed", { threadId: thread.id, turn: publicTurn(turn) });
    const next = queued.get(thread.id)?.shift();
    if (next !== undefined && socket !== undefined) {
      const nextTurn = newTurn();
      thread.turns.push(nextTurn);
      void runTurn(socket, thread, nextTurn, next, "");
    }
  }

  function askApproval(thread: ThreadRecord, turn: TurnRecord): Promise<string> {
    return new Promise((resolve) => {
      requestCounter += 1;
      const requestId = String(requestCounter);
      const item: ItemRecord = {
        id: `approval-${requestId}`,
        type: "commandExecution",
        command: "touch approved.txt",
        commandActions: [],
        cwd: thread.cwd,
        status: "inProgress",
        aggregatedOutput: null,
      };
      turn.items.push(item);
      notify("item/started", {
        item,
        threadId: thread.id,
        turnId: turn.id,
        startedAtMs: Date.now(),
      });
      pendingApprovals.set(requestId, {
        turn,
        thread,
        decide: (decision) => {
          notify("item/completed", {
            item: { ...item, status: decision === "accept" ? "completed" : "declined" },
            threadId: thread.id,
            turnId: turn.id,
            completedAtMs: Date.now(),
          });
          notify("serverRequest/resolved", {
            threadId: thread.id,
            requestId: Number(requestId),
          });
          resolve(decision);
        },
      });
      for (const client of clients) {
        send(client, {
          id: Number(requestId),
          method: "item/commandExecution/requestApproval",
          params: {
            kind: "command",
            threadId: thread.id,
            turnId: turn.id,
            itemId: item.id,
            startedAtMs: Date.now(),
            environmentId: "local",
            reason: "the stub asks before writing",
            command: "touch approved.txt",
            cwd: thread.cwd,
            commandActions: [],
            availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
          },
        });
      }
    });
  }

  async function close(): Promise<void> {
    for (const client of clients) client.terminate();
    clients.clear();
    wss.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }

  await new Promise<void>((resolve) => http.listen(options.socketPath, () => resolve()));

  return { frames, close };
}

function loadThreads(journal: string | undefined): Map<string, ThreadRecord> {
  const threads = new Map<string, ThreadRecord>();
  if (journal === undefined) return threads;
  let text = "";
  try {
    text = readFileSync(journal, "utf8");
  } catch {
    return threads;
  }
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as { thread?: ThreadRecord };
      if (parsed.thread !== undefined) threads.set(parsed.thread.id, parsed.thread);
    } catch {
      // A partial line from a killed server is not a thread.
    }
  }
  return threads;
}

function newThread(cwd: string, prefix: string): ThreadRecord {
  const now = Date.now();
  return {
    id: `${prefix}-${now}-${itemCounter()}`,
    cwd,
    preview: "",
    ephemeral: false,
    createdAt: now,
    recencyAt: now,
    turns: [],
  };
}

function newTurn(): TurnRecord {
  return { id: `turn-${itemCounter()}`, status: "inProgress", items: [] };
}

function userItem(text: string, id: string, clientId: string): ItemRecord {
  return {
    id,
    type: "userMessage",
    clientId: clientId === "" ? null : clientId,
    content: [{ type: "text", text, text_elements: [] }],
  };
}

function itemCounter(): string {
  counter += 1;
  return `${counter}-${Math.floor(Math.random() * 1e6)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The text of a `turn/start`/`turn/steer`/`thread/queue/add` input array. */
function inputText(params: Record<string, unknown>): string {
  const input = Array.isArray(params["input"]) ? params["input"] : [];
  return input.map((each) => (isRecord(each) ? (stringOf(each["text"]) ?? "") : "")).join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** A WebSocket frame is `Buffer | ArrayBuffer | Buffer[]`; our clients send UTF-8 JSON text. */
function rawText(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  return "";
}
