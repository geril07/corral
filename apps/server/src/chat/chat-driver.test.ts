import type {
  ChatAnswer,
  ChatDriverCapabilities,
  ChatModelRef,
  ChatSessionState,
  ChatStreamMessage,
} from "@corral/protocol/chat";
import type { AgentKind, ChatSendMode } from "@corral/protocol/rpc";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import type {
  ChatDriver,
  ChatDriverRegistration,
  ChatDriverStart,
  ChatDriverRegistry,
  ChatLaunchFacts,
} from "./chat-driver.ts";
import { ChatLaunchError, ChatUnavailableError, type ChatSubject } from "./chat-errors.ts";
import { ChatService } from "./chat-service.ts";
import { CHAT_DRIVER_REGISTRY } from "./chat-drivers.ts";
import { floorPath, readFloor, SEQUENCE_BLOCK } from "./sequence-floor.ts";
import { ChatTimeline } from "./timeline.ts";
import { recordWriter, writerPath } from "./writer-claim.ts";

/**
 * A second driver, deliberately trivial: a timeline that echoes and nothing else — no child, no
 * provider protocol, no supervision of its own. It exists to prove the extraction: a new agent is
 * a `ChatDriver` implementation plus one registry line, and the one writer claim, the sequence
 * floor, the exit bookkeeping and the refusal vocabulary stay in `ChatService`, where a driver
 * cannot get them wrong. `claude` is C2's kind, which this build ships no product driver for.
 */
class EchoDriver implements ChatDriver {
  readonly timeline: ChatTimeline;
  readonly #launch: ChatDriverStart;
  #closed = false;
  #items = 0;

  constructor(launch: ChatDriverStart) {
    this.#launch = launch;
    this.timeline = new ChatTimeline(launch.startAt);
  }

  get sessionId(): string {
    return this.#launch.sessionId;
  }

  get state(): ChatSessionState {
    return this.timeline.state;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get startAt(): number {
    return this.#launch.startAt;
  }

  get args(): string[] {
    return this.#launch.args;
  }

  start(): void {
    this.#launch.onStatus({ state: "idle", updatedAt: Date.now() });
    // The launch prompt, if any, is the first user message — the driver's own rule, as pi's is.
    if (this.#launch.prompt !== null) this.send(this.#launch.prompt, "prompt");
  }

  async stop(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.timeline.close();
    this.#launch.onExit(null);
  }

  send(text: string, _mode: ChatSendMode): string {
    this.#items += 1;
    const itemId = `echo-${this.#items}`;
    this.timeline.put({ kind: "user-message", id: itemId, text });
    this.timeline.put({
      kind: "assistant-message",
      id: `${itemId}-answer`,
      text: `echo: ${text}`,
      streaming: false,
    });
    return itemId;
  }

  async abort(): Promise<void> {
    this.timeline.setState({ turn: "aborted" });
  }

  respond(_itemId: string, _value: ChatAnswer): void {}

  async setModel(_model: ChatModelRef): Promise<void> {}

  async setReasoning(_level: string): Promise<void> {}
}

interface Harness {
  registry: ChatDriverRegistry;
  /** Every frontend this registry built, in order: a launch can be counted without a child. */
  started: EchoDriver[];
  registryOf(facts: ChatLaunchFacts): ChatDriverRegistration;
}

function echoRegistry(): Harness {
  const started: EchoDriver[] = [];
  const registration: ChatDriverRegistration = {
    capabilities: {
      steer: false,
      followUp: false,
      approvals: false,
      modelSwitch: false,
      reasoningLevels: false,
      terminalView: "both-live",
    },
    args: (facts) => ["--echo", facts.how, facts.agentSessionId ?? "new"],
    create: (launch) => {
      const driver = new EchoDriver(launch);
      started.push(driver);
      return driver;
    },
  };
  return {
    registry: { ...CHAT_DRIVER_REGISTRY, claude: registration },
    started,
    registryOf: () => registration,
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "corral-chat-driver-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function chatService(harness?: Harness): ChatService {
  return new ChatService({
    dataDir: root,
    timeouts: { dialogTimeoutMs: 1000, readyTimeoutMs: 2000, exitGraceMs: 500, writerWaitMs: 1000 },
    ...(harness === undefined ? {} : { drivers: harness.registry }),
  });
}

function request(sessionId: string, kind: AgentKind, prompt: string | null = null) {
  return {
    sessionId,
    kind,
    command: "agent",
    cwd: root,
    env: {},
    model: "stub-1",
    provider: "stub",
    agentSessionId: "conversation-1",
    how: "resume" as const,
    prompt,
    onStatus: () => undefined,
    onExit: () => undefined,
  };
}

/** A running chat session of one agent, as the session service would report it. */
function subject(sessionId: string, kind: "pi" | "claude"): ChatSubject {
  return { sessionId, view: "chat", kind, state: "running" };
}

async function firstWatch(
  service: ChatService,
  sessionId: string,
  kind: "pi" | "claude",
): Promise<ChatStreamMessage> {
  const watch = service.watch(subject(sessionId, kind), undefined, undefined);
  const first = await watch.next();
  await watch.return(undefined);
  return first.value!;
}

test("a driver is one registry entry: it answers chat.capabilities and starts through the service", async () => {
  const harness = echoRegistry();
  const chat = chatService(harness);
  try {
    // The record is the driver's declaration, the kind is the registry's key.
    expect(recordsOf(chat.capabilities())).toEqual([
      "claude:both-live:",
      "pi:handoff-only:steer,followUp,approvals,modelSwitch,reasoningLevels",
    ]);
    expect(chat.hasDriver("claude")).toBe(true);

    await chat.launch(request("echo-1", "claude", "hello"));
    expect(harness.started).toHaveLength(1);

    // The service built the launch: the driver only shapes its own argv, and it saw ours.
    expect(harness.started[0]!.args).toEqual(["--echo", "resume", "conversation-1"]);
    // The release of the prompt is the driver's own rule, as pi's is.
    const first = await firstWatch(chat, "echo-1", "claude");
    expect(first.type).toBe("snapshot");
    expect(first.type === "snapshot" ? first.snapshot.items : []).toMatchObject([
      { kind: "user-message", id: "echo-1", text: "hello" },
      { kind: "assistant-message", text: "echo: hello" },
    ]);

    // A send goes through the driver and comes back as an item id, as the contract promises.
    expect(chat.send(subject("echo-1", "claude"), "again", "steer")).toBe("echo-2");
  } finally {
    await chat.closeAll();
  }
});

test("the registry refuses an agent kind this build has no driver for", async () => {
  const harness = echoRegistry();
  const chat = chatService(harness);
  try {
    // `codex` is an agent kind without a driver: the refusal names it and nothing is claimed.
    await expect(chat.launch(request("echo-2", "codex"))).rejects.toThrow(ChatLaunchError);
    await expect(chat.launch(request("echo-2", "codex"))).rejects.toThrow(
      "the codex agent has no chat driver in this build",
    );
    expect(harness.started).toHaveLength(0);
    // The build's own registry ships pi and nothing else; the seam is what added claude.
    expect(recordsOf(chatService().capabilities())).toEqual([
      "pi:handoff-only:steer,followUp,approvals,modelSwitch,reasoningLevels",
    ]);
  } finally {
    await chat.closeAll();
  }
});

test("one writer per session is the service's, not the driver's", async () => {
  const harness = echoRegistry();
  const chat = chatService(harness);
  // A writer record a previous server left, naming a live process with no readable identity: the
  // service stops it before any driver starts, and the driver never sees the record.
  const sleeper = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  try {
    recordWriter(writerPath(`${root}/chat`, "echo-3"), sleeper.pid!);
    await chat.launch(request("echo-3", "claude"));
    expect(await gone(sleeper)).toBe(true);
    expect(harness.started).toHaveLength(1);

    // Two concurrent launches of one id: one frontend, one typed refusal, however the driver is
    // written — the claim is taken before the first await, inside the service.
    const results = await Promise.allSettled([
      chat.launch(request("echo-4", "claude")),
      chat.launch(request("echo-4", "claude")),
    ]);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.any(ChatLaunchError),
    });
    expect(harness.started).toHaveLength(2);
  } finally {
    kill(sleeper);
    await chat.closeAll();
  }
});

test("the sequence floor and the exit bookkeeping stay outside the driver", async () => {
  const harness = echoRegistry();
  const chat = chatService(harness);
  try {
    await chat.launch(request("echo-5", "claude"));
    // Reserved and persisted before the driver existed, and handed to it as its timeline's start.
    expect(harness.started[0]!.startAt).toBe(0);
    expect(readFloor(floorPath(`${root}/chat`, "echo-5"))).toBe(SEQUENCE_BLOCK);

    chat.send(subject("echo-5", "claude"), "one", "prompt");
    await chat.stop("echo-5");
    // The driver said only "I ended"; the service keeps the larger of its reservation and the
    // sequence the frontend actually emitted, so no cursor from it can replay into a new timeline.
    expect(readFloor(floorPath(`${root}/chat`, "echo-5"))).toBeGreaterThanOrEqual(
      harness.started[0]!.timeline.sequence + 1,
    );
    // And the refusal of a stopped frontend is the service's vocabulary, not the driver's.
    expect(() => chat.send(subject("echo-5", "claude"), "two", "prompt")).toThrow(
      ChatUnavailableError,
    );
  } finally {
    await chat.closeAll();
  }
});

/** Each capability record as one sorted line, so a diff shows which driver changed what. */
function recordsOf(records: ChatDriverCapabilities[]): string[] {
  return records.map(({ kind, terminalView, ...flags }) => {
    const on = Object.entries(flags)
      .filter(([, value]) => value)
      .map(([name]) => name);
    return `${kind}:${terminalView}:${on.join(",")}`;
  });
}

function kill(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch {
    // Already gone, or no group of its own.
  }
}

/** Whether the process is gone, polling briefly: the service awaits the exit itself. */
async function gone(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 1000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
