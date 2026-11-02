import type { ChatItem } from "@corral/protocol/chat";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { resetCodexVersionCache } from "../agents/codex-version.ts";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { isRecord } from "../../test/json.ts";
import { CodexDriver, type CodexDriverRequest } from "./codex-driver.ts";
import { CodexServers } from "./codex-server.ts";
import { ChatTimeline } from "./timeline.ts";

// The fake agents go first on PATH and CODEX_HOME is a temp directory for this file.
useFakeAgents();
// The version is cached per executable for the server's lifetime; a test may swap it.
resetCodexVersionCache();
const FAKE_CODEX = join(import.meta.dirname, "../../test/fake-agents/bin/codex");

interface Harness {
  root: string;
  dataDir: string;
  servers: CodexServers;
  drivers: CodexDriver[];
  statuses: string[];
  /** A driver on the session's app-server; `stop()` leaves the server for the next one. */
  open(options?: {
    prompt?: string | null;
    model?: string | null;
    provider?: string | null;
    agentSessionId?: string | null;
    onAgentSessionId?: (id: string) => void;
  }): Promise<{
    driver: CodexDriver;
    timeline: ChatTimeline;
    /** Resolves once the frontend reported its first state (or exited). */
    ready: Promise<void>;
    exited: Promise<string | null>;
  }>;
  /** Stops every driver and the server, and removes the data directory. */
  close(): Promise<void>;
}

/** One pool on a fresh data directory; each `open` is a frontend of the same session. */
async function harness(sessionId = "corral-codex-session"): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "corral-codex-"));
  const dataDir = join(root, "data");
  const servers = new CodexServers({ dataDir, readyTimeoutMs: 10_000, exitGraceMs: 500 });
  const drivers: CodexDriver[] = [];
  const statuses: string[] = [];
  return {
    root,
    dataDir,
    servers,
    drivers,
    statuses,
    async open(options = {}) {
      // A test may swap the fake executable's version; the cache is per executable.
      resetCodexVersionCache();
      const server = await servers.acquire("chat", {
        sessionId,
        command: FAKE_CODEX,
        cwd: root,
        env: processEnv(),
      });
      const timeline = new ChatTimeline(0);
      let resolveExit: (reason: string | null) => void = () => undefined;
      const exited = new Promise<string | null>((resolve) => (resolveExit = resolve));
      let resolveReady: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => (resolveReady = resolve));
      const request: CodexDriverRequest = {
        sessionId,
        timeline,
        command: FAKE_CODEX,
        args: [],
        cwd: root,
        env: processEnv(),
        prompt: options.prompt ?? null,
        model: options.model ?? null,
        provider: options.provider ?? null,
        agentSessionId: options.agentSessionId ?? null,
        socket: server.socketPath,
        writer: { record: () => {}, release: () => {} },
        ...(options.onAgentSessionId === undefined
          ? {}
          : { onAgentSessionId: options.onAgentSessionId }),
        dialogTimeoutMs: 3000,
        readyTimeoutMs: 8000,
        exitGraceMs: 500,
        onStatus: (status) => {
          statuses.push(status.state);
          resolveReady();
        },
        onExit: (reason) => {
          resolveReady();
          resolveExit(reason);
        },
      };
      const driver = new CodexDriver(request);
      drivers.push(driver);
      driver.start();
      return { driver, timeline, ready, exited };
    },
    async close() {
      for (const driver of drivers) await driver.stop().catch(() => undefined);
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

function items(timeline: ChatTimeline): ChatItem[] {
  return timeline.snapshot().items;
}

function textOf(timeline: ChatTimeline): string {
  return items(timeline)
    .flatMap((item) => (item.kind === "assistant-message" ? [item.text] : []))
    .join("");
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

async function journal(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as unknown)
    .filter(isRecord);
}

test(
  "a turn streams text, reports the assigned thread id and settles",
  { timeout: 20_000 },
  async () => {
    const test1 = await harness();
    const journalPath = join(test1.root, "server.jsonl");
    process.env["FAKE_CODEX_SERVER_LOG"] = journalPath;
    try {
      const reported: string[] = [];
      const { driver, timeline } = await test1.open({
        prompt: "stream please",
        onAgentSessionId: (id) => reported.push(id),
      });
      await until(() => textOf(timeline).includes("the stub answer"), "the streamed answer");
      await until(() => timeline.state.turn === "settled", "the settled turn");

      // The id is the server's (thread/start takes none), and the session row learns it here.
      expect(reported).toHaveLength(1);
      expect(reported[0]).toMatch(/^thr-/);
      expect(timeline.state.model).toMatchObject({ id: "stub-model", provider: "stub" });
      expect(items(timeline).find((item) => item.kind === "user-message")).toMatchObject({
        text: "stream please",
      });
      expect(test1.statuses).toContain("working");
      expect(test1.statuses).toContain("done");
      expect(driver.closed).toBe(false);
    } finally {
      await test1.close();
    }
  },
);

test(
  "a resume rebuilds the transcript and never resends the task prompt",
  { timeout: 20_000 },
  async () => {
    const test1 = await harness("corral-codex-resume");
    const journalPath = join(test1.root, "server.jsonl");
    process.env["FAKE_CODEX_SERVER_LOG"] = journalPath;
    try {
      let threadId = "";
      const first = await test1.open({
        prompt: "do the thing",
        onAgentSessionId: (id) => (threadId = id),
      });
      await until(() => first.timeline.state.turn === "settled", "the first settled turn");
      await first.driver.stop();
      await test1.servers.release("chat", "corral-codex-resume");

      // A second frontend on the same session id and the same candidate prompt.
      const second = await test1.open({ prompt: "do the thing", agentSessionId: threadId });
      await until(() => second.timeline.state.turn !== "idle", "the resumed conversation");
      await until(() => textOf(second.timeline).includes("the stub answer"), "the rebuilt answer");

      // Exactly one user message: the prompt that was already in the conversation (C1's P0).
      const userMessages = items(second.timeline).filter((item) => item.kind === "user-message");
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]).toMatchObject({ text: "do the thing" });
      const threads = (await journal(journalPath)).map((entry) => entry["thread"]).filter(isRecord);
      const turns = threads.flatMap((thread) =>
        Array.isArray(thread["turns"]) ? thread["turns"] : [],
      );
      expect(turns).toHaveLength(1);
    } finally {
      await test1.close();
    }
  },
);

test(
  "the launch's model and provider open the thread, not the app-server's default",
  { timeout: 20_000 },
  async () => {
    const test1 = await harness("corral-codex-model");
    const journalPath = join(test1.root, "server.jsonl");
    process.env["FAKE_CODEX_SERVER_LOG"] = journalPath;
    try {
      await test1.open({ model: "stub-alt", provider: "work" });
      await until(async () => {
        const threads = (await journal(journalPath))
          .map((entry) => entry["thread"])
          .filter(isRecord);
        return threads.some((thread) => thread["model"] === "stub-alt");
      }, "the thread to carry the launch's model");
      const threads = (await journal(journalPath)).map((entry) => entry["thread"]).filter(isRecord);
      expect(threads[0]).toMatchObject({ model: "stub-alt", modelProvider: "work" });
    } finally {
      await test1.close();
    }
  },
);

test(
  "a thread the terminal started is adopted instead of starting a second one",
  { timeout: 20_000 },
  async () => {
    const test1 = await harness("corral-codex-adopt");
    const journalPath = join(test1.root, "server.jsonl");
    process.env["FAKE_CODEX_SERVER_LOG"] = journalPath;
    try {
      // What a terminal leg leaves behind: a thread in the app-server, before any chat frontend.
      const server = await test1.servers.acquire("terminal", {
        sessionId: "corral-codex-adopt",
        command: FAKE_CODEX,
        cwd: test1.root,
        env: processEnv(),
      });
      expect(server.socketPath).toContain("corral-codex-adopt.sock");
      const terminalThread = await seedThread(server.socketPath, test1.root);
      await test1.servers.release("terminal", "corral-codex-adopt");

      const reported: string[] = [];
      const { timeline } = await test1.open({
        prompt: "continue",
        onAgentSessionId: (id) => reported.push(id),
      });
      await until(() => timeline.state.turn !== "idle", "the adopted conversation");
      expect(reported).toEqual([terminalThread]);
    } finally {
      await test1.close();
    }
  },
);

test(
  "steer reaches the running turn and interrupt leaves it aborted",
  { timeout: 20_000 },
  async () => {
    const test1 = await harness();
    process.env["FAKE_CODEX_SERVER_LOG"] = join(test1.root, "server.jsonl");
    try {
      const { driver, timeline, ready } = await test1.open();
      await ready;
      driver.send("SLOW turn", "prompt");
      await until(() => timeline.state.turn === "working", "the working turn");
      driver.send("steer this way", "steer");
      await until(
        () =>
          items(timeline).some(
            (item) => item.kind === "user-message" && item.text === "steer this way",
          ),
        "the steered message",
      );
      // A follow-up is declared off: it is refused visibly and is not added as a sent message.
      const refused = driver.send("a follow-up", "follow-up");
      expect(refused).toMatch(/^error:send:/);
      expect(
        items(timeline).some((item) => item.kind === "user-message" && item.text === "a follow-up"),
      ).toBe(false);

      await driver.abort();
      await until(() => timeline.state.turn === "aborted", "the aborted turn");
      // The text that streamed before the interrupt stayed in the timeline.
      expect(textOf(timeline)).toContain("part 0");
    } finally {
      await test1.close();
    }
  },
);

test(
  "an approval is answered once, and a second frontend cannot answer it again",
  { timeout: 20_000 },
  async () => {
    const test1 = await harness("corral-codex-approval");
    const journalPath = join(test1.root, "server.jsonl");
    const decisionsPath = `${journalPath}.decisions`;
    process.env["FAKE_CODEX_SERVER_LOG"] = journalPath;
    try {
      const writer = await test1.open();
      // The writer's thread exists before the second frontend opens, so it adopts that one: two
      // concurrent starts would race `thread/list` and could open two threads.
      await writer.ready;
      const observer = await test1.open();
      await observer.ready;
      writer.driver.send("APPROVE please", "prompt");
      await until(
        () => items(writer.timeline).some((item) => item.kind === "user-request"),
        "the approval request",
      );

      // The terminal view is a second client of the same app-server and sees the same request.
      await until(
        () => items(observer.timeline).some((item) => item.kind === "user-request"),
        "the approval on the second frontend",
      );
      const writerRequest = items(writer.timeline).find((item) => item.kind === "user-request")!;
      const observerRequest = items(observer.timeline).find(
        (item) => item.kind === "user-request",
      )!;
      // Only what the server offered: the real request carried an object-valued decision too,
      // which has no plain-string form in the contract and is not offered.
      expect(
        writerRequest.kind === "user-request" &&
          writerRequest.options.map((option) => option.value),
      ).toEqual(["accept", "cancel"]);
      // The unmapped `item/tool/requestUserInput` the fake sends on `thread/start` was left
      // unanswered, not refused with a JSON-RPC error: give a wrong answer time to arrive.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await readFile(decisionsPath, "utf8").catch(() => "")).not.toContain(
        "unexpectedAnswer",
      );

      writer.driver.respond(writerRequest.id, "accept");
      // The server received exactly the decision it offered.
      await until(async () => {
        const log = await readFile(decisionsPath, "utf8").catch(() => "");
        return (
          log.includes('"decision":"accept"') || log.includes('"result":{"decision":"accept"}')
        );
      }, "the decision the server received");
      await until(
        () => writer.timeline.state.turn === "settled",
        `the approved turn (state ${writer.timeline.state.turn}; items ${JSON.stringify(items(writer.timeline))})`,
      );
      // The first answer wins: the other frontend's item is resolved and answering it is refused.
      await until(() => {
        const item = observer.timeline.item(observerRequest.id);
        return item?.kind === "user-request" && item.status === "answered";
      }, "the resolved request on the second frontend");
      expect(() => observer.driver.respond(observerRequest.id, "decline")).toThrow(
        /not waiting for an answer/,
      );
    } finally {
      await test1.close();
    }
  },
);

test(
  "an untested codex version is a visible refusal, not a frontend",
  { timeout: 20_000 },
  async () => {
    const test1 = await harness();
    process.env["FAKE_CODEX_VERSION"] = "0.165.0";
    resetCodexVersionCache();
    try {
      const { driver, exited } = await test1.open();
      const reason = await Promise.race([
        exited,
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), 8000).unref();
        }),
      ]);
      // A driver that accepts an untested version never exits, and that is what this fails on.
      expect(reason, "an untested version was accepted as a chat frontend").not.toBeNull();
      expect(reason).toContain("0.165.0");
      expect(reason).toContain("0.166.0");
      expect(reason).toContain("terminal");
      expect(driver.closed).toBe(true);
    } finally {
      delete process.env["FAKE_CODEX_VERSION"];
      await test1.close();
    }
  },
);

test("a server that dies closes the frontend with its reason", { timeout: 20_000 }, async () => {
  const test1 = await harness("corral-codex-crash");
  process.env["FAKE_CODEX_SERVER_LOG"] = join(test1.root, "server.jsonl");
  try {
    const { driver, ready, exited } = await test1.open();
    await ready;
    driver.send("CRASH now", "prompt");
    expect(await exited).not.toBeNull();
    expect(driver.closed).toBe(true);
  } finally {
    await test1.close();
  }
});

/** A thread created by a "terminal" frontend, through the same fake app-server. */
async function seedThread(socketPath: string, cwd: string): Promise<string> {
  const WebSocket = (await import("ws")).default;
  const socket = new WebSocket(`ws+unix://${socketPath}:/`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const answer = await new Promise<Record<string, unknown>>((resolve) => {
    socket.on("message", (data: Buffer) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      if (frame["id"] === 1) resolve(frame);
    });
    socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "thread/start",
        params: { cwd },
      }),
    );
  });
  socket.close();
  const result = answer["result"];
  if (typeof result !== "object" || result === null) return "";
  const thread = (result as Record<string, unknown>)["thread"];
  if (typeof thread !== "object" || thread === null) return "";
  const id = (thread as Record<string, unknown>)["id"];
  return typeof id === "string" ? id : "";
}
