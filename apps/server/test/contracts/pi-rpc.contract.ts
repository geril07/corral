// The real pi binary against Corral's own RPC client (`src/chat/pi-driver.ts`): start with a
// prompt → streamed answer, a real `edit` tool call and a real extension dialog → resume on the
// same pi session id, with the earlier turn in pi's history and in the stub's next request.
//
// The view handoff (B4) is measured in both of its real directions: the id is reopened by pi's
// non-interactive CLI and then by the **interactive TUI in a PTY** — the frontend `prefix v`
// actually starts — and the driver resumes after each, so what the other frontend wrote is what the
// chat rebuilds. Every frontend is waited for before the next one starts.
//
// It costs nothing and touches nothing of the user's: pi runs with an isolated
// `PI_CODING_AGENT_DIR` (its own `models.json` and extension), an isolated session directory,
// `PI_OFFLINE=1`, and a local OpenAI-compatible stub on port 0 that answers with a tool call and
// then with text. Ported from the pre-run probe in `.e2e/stage-b/probe/` (which is gitignored);
// this file is the tracked evidence that the hand-written client still follows the installed pi.
// Skipped when `pi` is not on the PATH.
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn as spawnPty } from "node-pty";
import { afterAll, beforeAll, expect, test } from "vite-plus/test";
import type { ChatItem } from "@corral/protocol/chat";
import type { AgentStatus } from "@corral/protocol/rpc";
import { isExecutable } from "../../src/agents/executable-lookup.ts";
import { PiDriver } from "../../src/chat/pi-driver.ts";
import { isRecord } from "../../src/chat/pi-record.ts";
import { writerPath } from "../../src/chat/writer-claim.ts";
import { createClientTerminal, screenLines, writeAndWait } from "../client-terminal.ts";

const PI = "pi";
const installed = isExecutable(PI, process.env["PATH"]);
const TIMEOUT_MS = 120_000;
const PI_SESSION_ID = "corral-contract-1";
const PROMPT = "Change hello.txt to say hello there, then tell me.";
const WORKSPACE_MESSAGE = "Which file did you change?";

let root: string;
let stub: Server;
/** Every chat-completions request the stub saw, oldest first. */
const requests: { messages: { role: string; content: unknown }[] }[] = [];
const statuses: AgentStatus[] = [];
let exitReason: string | null | undefined;

beforeAll(async () => {
  if (!installed) return;
  root = await mkdtemp(join(tmpdir(), "corral-pi-contract-"));
  stub = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      if (!request.url?.endsWith("/chat/completions")) {
        response.writeHead(404).end();
        return;
      }
      requests.push({ messages: messagesOf(JSON.parse(body || "{}")) });
      const withToolCall = requests.length === 1;
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta: object, finish: string | null = null): void => {
        response.write(
          `data: ${JSON.stringify({
            id: "stub-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "stub-1",
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        );
      };
      chunk({ role: "assistant", content: "" });
      if (withToolCall) {
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_contract_1",
              type: "function",
              function: { name: "edit", arguments: "" },
            },
          ],
        });
        chunk({
          tool_calls: [
            {
              index: 0,
              function: {
                arguments: JSON.stringify({
                  path: "hello.txt",
                  edits: [{ oldText: "hello world", newText: "hello there" }],
                }),
              },
            },
          ],
        });
        chunk({}, "tool_calls");
      } else {
        for (const word of "Changed hello.txt from world to there.".split(" ")) {
          chunk({ content: `${word} ` });
        }
        chunk({}, "stop");
      }
      response.end(`data: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
});

afterAll(async () => {
  if (!installed) return;
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

/** The messages of a chat-completions request body, as the stub logs them for the resume assertion. */
function messagesOf(body: unknown): { role: string; content: unknown }[] {
  if (!isRecord(body)) return [];
  const messages = body["messages"];
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message) => {
    if (!isRecord(message)) return [];
    const role = message["role"];
    return typeof role === "string" ? [{ role, content: message["content"] }] : [];
  });
}

/** The isolated agent directory: one stub provider, and the extension that asks for a confirmation. */
async function agentDir(): Promise<string> {
  const address = stub.address();
  if (address === null || typeof address === "string") throw new Error("the stub has no port");
  const dir = join(root, "agent");
  await mkdir(join(dir, "extensions"), { recursive: true });
  await writeFile(
    join(dir, "models.json"),
    JSON.stringify({
      $schema: "https://pi.dev/schemas/models.schema.json",
      providers: {
        stub: {
          name: "Stub",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          api: "openai-completions",
          apiKey: "stub-key",
          models: [
            {
              id: "stub-1",
              name: "Stub One",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 4096,
            },
            // A second model with reasoning, so the model/level switch below has a real target.
            {
              id: "stub-2",
              name: "Stub Two",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
        },
      },
    }),
  );
  // The tiniest dialog pi can be asked to forward: a real `extension_ui_request` on stdout.
  await writeFile(
    join(dir, "extensions", "confirm-edit.ts"),
    `export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const ok = await ctx.ui.confirm("Apply the edit?", "hello.txt will change.");
    if (!ok) return { block: true, reason: "The user declined." };
  });
}
`,
  );
  return dir;
}

function piEnv(agent: string): Record<string, string> {
  const keep = ["PATH", "SHELL", "LANG", "LC_ALL", "TZ"];
  const env = Object.fromEntries(
    keep.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
  );
  return {
    ...env,
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    PI_CODING_AGENT_DIR: agent,
    PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"),
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  };
}

/** The CLI frontend (print mode) with stdin closed and the output collected. */
function runCli(
  args: readonly string[],
  options: { cwd: string; env: Record<string, string> },
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(PI, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/** The bytes pi wrote into the isolated session directory, whatever the frontend was. */
async function sessionFileText(): Promise<string> {
  const names = await readdir(join(root, "sessions")).catch(() => [] as string[]);
  let text = "";
  for (const name of names.filter((each) => each.endsWith(".jsonl"))) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of session files, read in order
    text += await readFile(join(root, "sessions", name), "utf8").catch(() => "");
  }
  return text;
}

/** How many assistant messages pi has written, whichever frontend wrote them. */
function assistantMessages(text: string): number {
  return (text.match(/"role":"assistant"/g) ?? []).length;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

/**
 * The interactive pi TUI in a PTY — the frontend the terminal view starts (`pi --session-id <id>`
 * with no `--mode rpc`) — typing one message and waiting until pi has written the answer into its
 * session file. The PTY is then closed and its process awaited, so the driver that follows is the
 * only writer when it starts.
 */
async function tuiLeg(options: { agent: string; message: string }): Promise<void> {
  const size = { cols: 120, rows: 40 };
  const terminal = createClientTerminal(size);
  const child = spawnPty(
    PI,
    [
      "--provider",
      "stub",
      "--model",
      "stub-1",
      "--session-id",
      PI_SESSION_ID,
      "--no-approve",
      "--offline",
    ],
    {
      cwd: join(root, "workspace"),
      env: { ...piEnv(options.agent), TERM: "xterm-256color" },
      cols: size.cols,
      rows: size.rows,
      name: "xterm-256color",
    },
  );
  let lastOutput = Date.now();
  let rendered: Promise<unknown> = Promise.resolve();
  child.onData((chunk: string) => {
    lastOutput = Date.now();
    rendered = rendered.then(() => writeAndWait(terminal, chunk));
  });
  const exited = new Promise<number>((resolve) =>
    child.onExit(({ exitCode }) => resolve(exitCode)),
  );
  const quiet = async (ms: number): Promise<void> => {
    while (Date.now() - lastOutput < ms) {
      // oxlint-disable-next-line no-await-in-loop -- waiting for the TUI to stop drawing
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  try {
    // The footer hint is drawn once the composer is ready, and it pins that this really is pi's
    // interactive view (measured on 1.4.0, the version this file targets). Polling the screen is
    // what makes the wait independent of how fast the TUI's first paint arrives.
    await expect
      .poll(() => screenLines(terminal).join("\n"), {
        timeout: 60_000,
        message: "the TUI's composer",
      })
      .toContain("ctrl+o");
    await quiet(500);
    const before = requests.length;
    const assistantsBefore = assistantMessages(await sessionFileText());
    child.write(`${options.message}\r`);
    await expect
      .poll(() => requests.length, { timeout: 60_000, message: "the TUI's completion request" })
      .toBeGreaterThan(before);
    // pi has saved the turn when its session file holds the typed message and one more assistant
    // message than before. That file is the test's oracle; the driver turns it back into chat items.
    await expect
      .poll(async () => (await sessionFileText()).includes(options.message), {
        timeout: 60_000,
        message: "the TUI's turn in pi's session",
      })
      .toBe(true);
    await expect
      .poll(async () => assistantMessages(await sessionFileText()), {
        timeout: 60_000,
        message: "pi's answer to the TUI's turn",
      })
      .toBeGreaterThan(assistantsBefore);
    await quiet(500);
    expect(screenLines(terminal).join("\n")).toContain("Changed hello.txt");
  } finally {
    // SIGHUP first, as a closed terminal would send; a pi that ignores it must neither hang this
    // test to its own timeout nor leave a child behind, so the group is killed after a bounded wait.
    child.kill();
    const stopped = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000).unref()),
    ]);
    if (!stopped) {
      for (const target of [-child.pid, child.pid]) {
        try {
          process.kill(target, "SIGKILL");
        } catch {
          // The group is gone, or this pid is not one; the next target covers it.
        }
      }
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 5000).unref()),
      ]);
    }
  }
  // The TUI is gone before the next frontend exists — the same one-writer rule the driver keeps.
  await expect
    .poll(() => pidAlive(child.pid), { timeout: 10_000, message: "the TUI's exit" })
    .toBe(false);
}

/** A driver on the isolated pi, warned through `onStatus`/`onExit` so the test can wait on events. */
async function makeDriver(options: {
  prompt: string | null;
  onStatus?: (status: AgentStatus) => void;
}): Promise<PiDriver> {
  const agent = await agentDir();
  return new PiDriver({
    sessionId: "corral-contract-session",
    command: PI,
    args: [
      "--mode",
      "rpc",
      "--provider",
      "stub",
      "--model",
      "stub-1",
      "--session-id",
      PI_SESSION_ID,
    ],
    cwd: join(root, "workspace"),
    env: piEnv(agent),
    prompt: options.prompt,
    claimPath: writerPath(join(root, "chat"), "corral-contract-session"),
    startAt: 0,
    dialogTimeoutMs: 30_000,
    readyTimeoutMs: 30_000,
    exitGraceMs: 5_000,
    onStatus: (status) => {
      statuses.push(status);
      options.onStatus?.(status);
    },
    onExit: (reason) => {
      exitReason = reason;
    },
  });
}

const items = (driver: PiDriver): ChatItem[] => driver.timeline.snapshot().items;

const toolCall = (driver: PiDriver) => {
  const item = items(driver).find((candidate) => candidate.kind === "tool-call");
  return item?.kind === "tool-call" ? item : undefined;
};

const request = (driver: PiDriver) => {
  const item = items(driver).find((candidate) => candidate.kind === "user-request");
  return item?.kind === "user-request" ? item : undefined;
};

test.skipIf(!installed)(
  "pi streams an answer, runs a real edit after a real dialog, and resumes on the same session id",
  async () => {
    await mkdir(join(root, "workspace"), { recursive: true });
    await writeFile(join(root, "workspace", "hello.txt"), "hello world\n");

    const first = await makeDriver({ prompt: PROMPT });
    first.start();
    try {
      // The turn reaches the real extension's dialog and waits for an answer from the client.
      await expect
        .poll(() => request(first)?.status, { timeout: 60_000, message: "the dialog request" })
        .toBe("pending");
      const dialog = request(first)!;
      expect(dialog).toMatchObject({
        request: "confirm",
        title: "Apply the edit?",
        body: "hello.txt will change.",
        expiresAt: expect.any(Number),
      });
      first.respond(dialog.id, true);

      await expect
        .poll(() => first.timeline.state.turn, { timeout: 60_000, message: "the settled turn" })
        .toBe("settled");

      expect(items(first).find((item) => item.kind === "user-message")).toMatchObject({
        text: PROMPT,
      });
      expect(
        items(first).find((item) => item.kind === "assistant-message")?.kind ===
          "assistant-message" && items(first).find((item) => item.kind === "assistant-message"),
      ).toMatchObject({ text: expect.stringContaining("Changed hello.txt"), streaming: false });
      // The diff is pi's own unified patch from the tool result, path from the call's arguments.
      expect(toolCall(first)).toMatchObject({
        name: "edit",
        status: "done",
        diff: {
          path: "hello.txt",
          text: expect.stringContaining("--- hello.txt"),
        },
      });
      expect(toolCall(first)?.diff?.text).toContain("+hello there");
      expect(request(first)).toMatchObject({ status: "answered", answer: true });
      expect(await readFile(join(root, "workspace", "hello.txt"), "utf8")).toBe("hello there\n");
      expect(
        statuses.some((status) => status.state === "blocked" && status.kind === "question"),
      ).toBe(true);
      expect(statuses.at(-1)?.state).toBe("done");
    } finally {
      await first.stop();
    }
    expect(exitReason).toBeNull();

    // Resume the same pi session id *with the task's prompt again*: the rule is that pi's own
    // history decides it is not a first start, so nothing is handed over and the chat is rebuilt
    // from history. The next turn then proves pi carried the earlier conversation forward.
    const second = await makeDriver({ prompt: PROMPT });
    second.start();
    try {
      await expect
        .poll(() => second.timeline.state.model?.id, {
          timeout: 30_000,
          message: "the resumed state",
        })
        .toBe("stub-1");
      expect(items(second).map((item) => item.kind)).toEqual(
        expect.arrayContaining(["user-message", "assistant-message", "tool-call"]),
      );
      expect(items(second).find((item) => item.kind === "user-message")).toMatchObject({
        text: PROMPT,
      });
      expect(toolCall(second)).toMatchObject({ status: "done", diff: { path: "hello.txt" } });
      // The real guard against a resent prompt: a resend appends a second user-message item at
      // once, whereas its stub request may not have arrived yet, so counting items cannot race.
      expect(items(second).filter((item) => item.kind === "user-message")).toHaveLength(1);

      const requestsBefore = requests.length;
      second.send(WORKSPACE_MESSAGE, "prompt");
      await expect
        .poll(() => requests.length, { timeout: 60_000, message: "the resumed turn's request" })
        .toBeGreaterThan(requestsBefore);
      const resumed = requests.at(-1)!;
      const roles = resumed.messages.map((message) => message.role);
      expect(roles.slice(0, 2)).toEqual(["system", "user"]);
      // pi rebuilt the earlier turn from its own session file: the tool result is in the request.
      expect(JSON.stringify(resumed.messages)).toContain("hello there");
      const last = resumed.messages.at(-1)!;
      expect(last.role).toBe("user");
      // Newer pi sends content blocks; the words are what matters here.
      expect(JSON.stringify(last.content)).toContain(WORKSPACE_MESSAGE);

      // The ref shapes the chat's pickers send: a model from pi's own list, then a level from the
      // list the new model reports. A wrong shape or provider is refused by the real binary. Last,
      // because a reasoning model changes the prompt's first role from `system` to `developer`.
      const target = second.timeline.state.models.find((model) => model.id === "stub-2");
      expect(target, "the stub provider's second model").toBeDefined();
      await second.setModel({ provider: target!.provider, id: target!.id });
      await expect
        .poll(() => second.timeline.state.model?.id, {
          timeout: 30_000,
          message: "the switched model",
        })
        .toBe("stub-2");
      const levels = second.timeline.state.reasoningLevels;
      expect(levels.length, "the new model's thinking levels").toBeGreaterThan(0);
      const level = levels.at(-1)!;
      await second.setReasoning(level);
      await expect
        .poll(() => second.timeline.state.reasoning, {
          timeout: 30_000,
          message: "the switched level",
        })
        .toBe(level);
    } finally {
      await second.stop();
    }

    // The handoff direction (B4): the same pi session opened by the CLI frontend — the terminal
    // view runs `pi` itself; `-p` is its non-interactive mode, which needs no PTY — and then by the
    // chat driver again. Each frontend sees the conversation the other wrote, on one session id.
    const cliMessage = "Sum up what changed.";
    const requestsBeforeCli = requests.length;
    // The CLI frontend with stdin closed: measured on pi 1.4.0, print mode waits for stdin EOF
    // (it takes piped input as part of the prompt), so an open pipe is a hang, not a run.
    // `--no-approve` keeps it from asking about project-local files it has nobody to ask.
    const cli = await runCli(
      [
        "-p",
        cliMessage,
        "--no-approve",
        "--offline",
        "--provider",
        "stub",
        "--model",
        "stub-1",
        "--session-id",
        PI_SESSION_ID,
      ],
      { cwd: join(root, "workspace"), env: piEnv(await agentDir()) },
    );
    expect(cli.output).toContain("Changed hello.txt");
    expect(cli.code).toBe(0);
    await expect
      .poll(() => requests.length, { timeout: 30_000, message: "the CLI frontend's request" })
      .toBeGreaterThan(requestsBeforeCli);
    const handedOver = requests.at(-1)!;
    // The CLI frontend resumed the chat's session: the whole earlier conversation is in its request.
    expect(JSON.stringify(handedOver.messages)).toContain("hello there");
    expect(JSON.stringify(handedOver.messages)).toContain(WORKSPACE_MESSAGE);
    expect(JSON.stringify(handedOver.messages.at(-1)!.content)).toContain(cliMessage);

    // Back to chat: the driver resumes the session the CLI wrote into, and the turn it added is
    // part of the rebuilt history — with the task's prompt passed again but not sent again.
    const third = await makeDriver({ prompt: PROMPT });
    third.start();
    try {
      await expect
        .poll(() => third.timeline.state.model?.id, {
          timeout: 30_000,
          message: "the third frontend's state",
        })
        .toBe("stub-1");
      const userMessages = items(third).filter((item) => item.kind === "user-message");
      // The prompt, the chat turn and the CLI turn — nothing else, no resent prompt.
      expect(userMessages).toHaveLength(3);
      expect(userMessages.at(-1)).toMatchObject({ text: cliMessage });
      expect(toolCall(third)).toMatchObject({ status: "done", diff: { path: "hello.txt" } });
    } finally {
      await third.stop();
    }

    // The direction B4 and B-verify actually exercise: the interactive TUI in a PTY, on the same
    // session id, typing its own turn. Its PTY is closed and its process awaited before the driver
    // starts, so this is one writer at a time on the real binary too.
    const tuiMessage = "Does the file still say hello there?";
    await tuiLeg({ agent: await agentDir(), message: tuiMessage });

    // Back to chat once more: what the TUI typed and pi's answer are in the rebuilt history, and
    // the task's prompt is still not sent a second time.
    const fourth = await makeDriver({ prompt: PROMPT });
    fourth.start();
    try {
      await expect
        .poll(() => fourth.timeline.state.model?.id, {
          timeout: 30_000,
          message: "the fourth frontend's state",
        })
        .toBe("stub-1");
      const userMessages = items(fourth).filter((item) => item.kind === "user-message");
      // The prompt, the chat turn, the CLI turn and the TUI turn — and no resent prompt.
      expect(userMessages).toHaveLength(4);
      expect(userMessages.at(-1)).toMatchObject({ text: tuiMessage });
      // pi answered the TUI turn; the rebuilt chat carries that answer, not only its question.
      expect(JSON.stringify(items(fourth))).toContain("Changed hello.txt");
      expect(toolCall(fourth)).toMatchObject({ status: "done", diff: { path: "hello.txt" } });
    } finally {
      await fourth.stop();
    }
  },
  TIMEOUT_MS,
);
