// The fake `opencode serve` of the server tests: the v2 API subset the chat driver speaks, with a
// journal of what it was asked to do. It runs as a real child process on a free loopback port and
// prints the two lines the real 2.2.5 prints, so the driver's start-up path is the real one.
//
// The provider side is scripted by the prompt's text, so a test can ask for a streamed answer with
// a tool call (`stream`), a turn that keeps running until it is interrupted (`hold`), or a turn
// that asks for permission first (`ask`). No model is called and no network is touched.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../test/json.ts";

interface SessionMessage {
  id: string;
  type: string;
  [key: string]: unknown;
}

interface StoredSession {
  id: string;
  title: string;
  directory: string;
  messages: SessionMessage[];
  permissions: Record<string, unknown>[];
  busy: boolean;
  outcome: string | null;
}

interface ToolPart {
  id: string;
  name: string;
  state: { status: string; input: unknown; content?: unknown; metadata?: unknown };
}

interface AssistantMessage extends SessionMessage {
  type: "assistant";
  content: unknown[];
}

/**
 * Runs the fake server until the process is killed. `stateDir` makes sessions survive a restart of
 * the process, as OpenCode's own data directory does.
 */
export function runFakeOpenCodeServer(options: {
  journal: string | undefined;
  stateDir: string | undefined;
  password: string;
  port: number;
  hostname: string;
}): void {
  const password = options.password;
  const sessions = new Map<string, StoredSession>();
  /** One event stream per attached client. */
  const streams = new Set<ServerResponse>();
  let events = 0;

  const journal = (entry: Record<string, unknown>) => {
    if (options.journal === undefined) return;
    const line = `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`;
    try {
      writeFileSync(options.journal, line, { flag: "a" });
    } catch {
      // The journal is evidence, not a reason to fail the server.
    }
  };

  const statePath = (id: string) =>
    options.stateDir === undefined ? undefined : join(options.stateDir, `${id}.json`);

  const save = (session: StoredSession) => {
    const path = statePath(session.id);
    if (path === undefined) return;
    try {
      mkdirSync(options.stateDir!, { recursive: true });
      writeFileSync(path, JSON.stringify(session));
    } catch {
      // Persistence is optional; the in-memory session is what the running server answers.
    }
  };

  const load = (id: string): StoredSession | undefined => {
    const existing = sessions.get(id);
    if (existing !== undefined) return existing;
    const path = statePath(id);
    if (path === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isStoredSession(parsed)) return undefined;
      sessions.set(id, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  };

  const emit = (type: string, data: Record<string, unknown>) => {
    events += 1;
    const frame = {
      id: `evt_fake${events}`,
      created: Date.now(),
      type,
      data,
    };
    const chunk = `data: ${JSON.stringify(frame)}\n\n`;
    for (const stream of streams) stream.write(chunk);
  };

  const authorized = (request: IncomingMessage): boolean => {
    const header = request.headers["authorization"] ?? "";
    const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    return header === expected;
  };

  const sessionOf = (url: URL): StoredSession | undefined => {
    const match = /^\/api\/session\/([^/]+)/.exec(url.pathname);
    return match?.[1] === undefined ? undefined : load(decodeURIComponent(match[1]));
  };

  /** The assistant message of the turn a scripted prompt starts; the history keeps it. */
  let assistant: AssistantMessage | undefined;
  let turnTools: ToolPart[] = [];

  const startAssistant = (session: StoredSession): AssistantMessage => {
    const message: AssistantMessage = {
      id: `msg_fakeassistant${session.messages.length + 1}`,
      type: "assistant",
      agent: "build",
      model: { id: "stub-model", providerID: "stub" },
      time: { created: Date.now() },
      content: [],
    };
    assistant = message;
    turnTools = [];
    session.messages.push(message);
    save(session);
    return message;
  };

  const textDelta = (session: StoredSession, delta: string) => {
    if (assistant === undefined) startAssistant(session);
    emit("session.text.delta", {
      sessionID: session.id,
      assistantMessageID: assistant!.id,
      ordinal: 0,
      delta,
    });
  };

  const endText = (session: StoredSession, text: string) => {
    if (assistant === undefined) startAssistant(session);
    assistant!.content = [
      ...assistant!.content.filter((part) => !(isRecord(part) && part["type"] === "text")),
      {
        type: "text",
        text,
      },
    ];
    emit("session.text.ended", {
      sessionID: session.id,
      assistantMessageID: assistant!.id,
      ordinal: 0,
      text,
    });
  };

  const tool = (session: StoredSession, name: string, input: unknown, diff?: string) => {
    if (assistant === undefined) startAssistant(session);
    const id = `tool_${turnTools.length + 1}`;
    const part: ToolPart = {
      id,
      name,
      state: {
        status: "completed",
        input,
        content: [{ type: "text", text: `${name} done` }],
        metadata: diff === undefined ? {} : { diff, path: "src/app.ts" },
      },
    };
    turnTools.push(part);
    assistant!.content = [...assistant!.content, { type: "tool", ...part }];
    emit("session.tool.input.started", {
      sessionID: session.id,
      assistantMessageID: assistant!.id,
      id,
      name,
    });
    emit("session.tool.input.ended", {
      sessionID: session.id,
      assistantMessageID: assistant!.id,
      id,
      text: JSON.stringify(input, null, 2),
    });
    emit("session.tool.called", {
      sessionID: session.id,
      assistantMessageID: assistant!.id,
      id,
      input,
      executed: true,
    });
    emit("session.tool.success", {
      sessionID: session.id,
      assistantMessageID: assistant!.id,
      id,
      executed: true,
      content: [{ type: "text", text: `${name} done` }],
      metadata: part.state.metadata,
    });
    return part;
  };

  const finish = (session: StoredSession, outcome: "succeeded" | "interrupted" | "failed") => {
    session.busy = false;
    session.outcome = outcome;
    session.messages.push({
      id: `msg_fakeidle${session.messages.length + 1}`,
      type: "idle",
      outcome,
    });
    save(session);
    assistant = undefined;
    if (outcome === "succeeded") emit("session.execution.succeeded", { sessionID: session.id });
    else if (outcome === "interrupted")
      emit("session.execution.interrupted", { sessionID: session.id, reason: "user" });
    else
      emit("session.execution.failed", { sessionID: session.id, error: { message: "it failed" } });
    emit("session.idle", { sessionID: session.id, outcome });
  };

  const deliver = (session: StoredSession, text: string, delivery: string | undefined) => {
    if (session.busy) {
      // A message while a turn runs is admitted as steering or queued; the scripted model answers
      // a steer with one more delta and leaves the turn running.
      if (delivery === "steer") textDelta(session, " (steered)");
      return;
    }
    session.busy = true;
    emit("session.execution.started", { sessionID: session.id });
    startAssistant(session);
    if (text === "hold") {
      textDelta(session, "holding");
      return;
    }
    if (text === "ask") {
      textDelta(session, "I need to edit a file.");
      const part = tool(session, "edit", { path: "src/app.ts" });
      const requestID = `per_${session.permissions.length + 1}`;
      const request = {
        id: requestID,
        sessionID: session.id,
        action: "edit",
        resources: ["src/app.ts"],
        message: "Allow editing src/app.ts?",
        source: { type: "tool", messageID: assistant!.id, id: part.id },
      };
      session.permissions.push(request);
      save(session);
      emit("permission.asked", request);
      return;
    }
    const answer = text.startsWith("stream") ? "Hello world" : `echo: ${text}`;
    textDelta(session, answer);
    endText(session, answer);
    tool(
      session,
      "edit",
      { path: "src/app.ts" },
      "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new",
    );
    setTimeout(() => finish(session, "succeeded"), 10).unref();
  };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (!authorized(request)) {
        json(response, 401, { _tag: "UnauthorizedError", message: "Authentication required" });
        return;
      }
      // The fake TUI announces itself with a header no real client sends; the journal is then
      // able to prove two clients (the driver's stream and the TUI) share one server.
      const tui = request.headers["x-fake-client"] === "tui";
      if (request.method === "GET" && url.pathname === "/api/event") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        response.write(
          `data: ${JSON.stringify({ id: "evt_fake0", type: "server.connected", data: {} })}\n\n`,
        );
        streams.add(response);
        journal({ action: "event-stream", clients: streams.size, tui });
        const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
        request.on("close", () => {
          clearInterval(heartbeat);
          streams.delete(response);
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/session") {
        const body = await readBody(request);
        const location = (body["location"] ?? {}) as { directory?: string };
        const id = typeof body["id"] === "string" ? body["id"] : `ses_fake${sessions.size + 1}`;
        const session: StoredSession = {
          id,
          title: typeof body["title"] === "string" ? body["title"] : "",
          directory: location.directory ?? process.cwd(),
          messages: [],
          permissions: [],
          busy: false,
          outcome: null,
        };
        sessions.set(id, session);
        save(session);
        journal({ action: "session-create", sessionID: id, directory: session.directory });
        json(response, 200, { data: sessionInfo(session) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/session") {
        json(response, 200, {
          data: [...sessions.values()].map(sessionInfo),
          cursor: { previous: null, next: null },
        });
        return;
      }
      const session = sessionOf(url);
      if (session === undefined) {
        journal({ action: "not-found", path: url.pathname });
        json(response, 404, { _tag: "SessionNotFoundError", message: "session not found" });
        return;
      }
      const rest = url.pathname.slice(`/api/session/${encodeURIComponent(session.id)}`.length);
      if (tui) journal({ action: "client", client: "tui", sessionID: session.id, path: rest });
      if (request.method === "GET" && rest === "") {
        json(response, 200, { data: sessionInfo(session) });
        return;
      }
      if (request.method === "GET" && rest === "/message") {
        json(response, 200, { data: session.messages, cursor: { previous: null, next: null } });
        return;
      }
      if (request.method === "GET" && rest === "/permission") {
        json(response, 200, { data: session.permissions });
        return;
      }
      if (request.method === "POST" && rest === "/prompt") {
        const body = await readBody(request);
        const text = typeof body["text"] === "string" ? body["text"] : "";
        const delivery = typeof body["delivery"] === "string" ? body["delivery"] : undefined;
        const id =
          typeof body["id"] === "string"
            ? body["id"]
            : `msg_fakeuser${session.messages.length + 1}`;
        session.messages.push({ id, type: "user", text, time: { created: Date.now() } });
        save(session);
        journal({ action: "prompt", sessionID: session.id, delivery: delivery ?? null, text });
        json(response, 200, {
          data: {
            id,
            sessionID: session.id,
            type: "user",
            payload: { text },
            delivery: delivery ?? "steer",
          },
        });
        deliver(session, text, delivery);
        return;
      }
      if (request.method === "POST" && rest === "/interrupt") {
        const interrupted = session.busy;
        journal({ action: "interrupt", sessionID: session.id, interrupted });
        if (interrupted) finish(session, "interrupted");
        json(response, 200, { interrupted });
        return;
      }
      const reply = /^\/permission\/([^/]+)\/reply$/.exec(rest);
      if (request.method === "POST" && reply?.[1] !== undefined) {
        const body = await readBody(request);
        const requestID = decodeURIComponent(reply[1]);
        journal({
          action: "permission-reply",
          sessionID: session.id,
          requestID,
          decision: body["decision"],
        });
        session.permissions = session.permissions.filter((each) => each["id"] !== requestID);
        save(session);
        emit("permission.replied", { sessionID: session.id, requestID });
        if (body["decision"] === "reject") {
          emit("session.execution.failed", {
            sessionID: session.id,
            error: { message: "the user rejected the tool" },
          });
          finish(session, "failed");
        } else {
          tool(
            session,
            "edit",
            { path: "src/app.ts" },
            "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new",
          );
          textDelta(session, " Edited the file.");
          endText(session, "I need to edit a file. Edited the file.");
          setTimeout(() => finish(session, "succeeded"), 10).unref();
        }
        response.writeHead(204).end();
        return;
      }
      journal({ action: "unsupported", method: request.method, path: url.pathname });
      json(response, 404, { _tag: "NotFoundError", message: `${url.pathname} is not faked` });
    })().catch((error: unknown) => {
      journal({ action: "error", message: error instanceof Error ? error.message : String(error) });
      if (!response.headersSent) json(response, 500, { message: "fake server failed" });
      else response.end();
    });
  });

  server.listen(options.port, options.hostname, () => {
    const address = server.address();
    if (address === null || typeof address === "string") return;
    const url = `http://${options.hostname}:${address.port}`;
    journal({ action: "listen", url, password });
    process.stdout.write(`server listening on ${url}\n`);
    process.stdout.write(`server password ${password}\n`);
  });

  const shutdown = (signal: string) => {
    journal({ action: "exit", signal });
    for (const stream of streams) stream.end();
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function sessionInfo(session: StoredSession): Record<string, unknown> {
  return {
    id: session.id,
    projectID: "project-fake",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: {
      created: Date.now(),
      updated: Date.now(),
      ...(session.busy ? { busy: Date.now() } : { idle: Date.now() }),
    },
    title: session.title,
    location: { directory: session.directory },
    ...(session.outcome === null ? {} : { outcome: session.outcome }),
    model: { id: "stub-model", providerID: "stub" },
  };
}

/** The fake's own session record, after a restart read it back from disk. */
function isStoredSession(value: unknown): value is StoredSession {
  return (
    isRecord(value) &&
    typeof value["id"] === "string" &&
    typeof value["title"] === "string" &&
    typeof value["directory"] === "string" &&
    Array.isArray(value["messages"]) &&
    Array.isArray(value["permissions"]) &&
    typeof value["busy"] === "boolean" &&
    (value["outcome"] === null || typeof value["outcome"] === "string")
  );
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = body === undefined ? "" : JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    // A request chunk is `any` in @types/node's async iterator; keep whatever it is as bytes.
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
