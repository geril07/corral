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
  options: { prompt?: string | null; sessionId?: string } = {},
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
    prompt: options.prompt ?? null,
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
    // Only the first prompt and the steer reached the server.
    expect(await prompts()).toHaveLength(2);

    await test1.driver.abort();
    await until(() => test1.timeline.state.turn === "aborted", "the interrupted turn");
    expect((await journal()).some((entry) => entry["action"] === "interrupt")).toBe(true);
  } finally {
    await test1.stop();
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
      expect(textOf(second)).toContain("Hello world");
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
