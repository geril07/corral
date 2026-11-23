import type {
  ChatAnswer,
  ChatDriverCapabilities,
  ChatModelRef,
  ChatSessionState,
  ChatStreamMessage,
} from "@corral/protocol/chat";
import type { AgentKind, ChatSendMode } from "@corral/protocol/rpc";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import type {
  ChatDriver,
  ChatDriverRegistration,
  ChatDriverStart,
  ChatDriverRegistry,
  ChatLaunchFacts,
  ChatSendReceipt,
} from "./chat-driver.ts";
import {
  ChatLaunchError,
  ChatReasoningUnsupportedError,
  ChatRefusalError,
  ChatUnavailableError,
  type ChatSubject,
} from "./chat-errors.ts";
import { MemoryChatChoices } from "./chat-choices.ts";
import { ChatService } from "./chat-service.ts";
import { piChatArgs } from "./pi-driver.ts";
import { CHAT_DRIVER_REGISTRY } from "./chat-drivers.ts";
import { floorPath, readFloor, SEQUENCE_BLOCK } from "./sequence-floor.ts";
import { ChatTimeline } from "./timeline.ts";
import { recordWriter, writerPath } from "./writer-claim.ts";

/**
 * A second driver, deliberately trivial: a timeline that echoes, one sleeping child and nothing
 * else — no provider protocol, no supervision of its own. It exists to prove the extraction: a new
 * agent is a `ChatDriver` implementation plus one registry line, while the launch claim, the
 * timeline's start, the writer record, the exit bookkeeping and the refusal vocabulary stay in
 * `ChatService`, where a driver cannot get them wrong. `claude` is C2's kind, which this build
 * ships no product driver for.
 */
class EchoDriver implements ChatDriver {
  readonly timeline: ChatTimeline;
  readonly #launch: ChatDriverStart;
  #child: ChildProcess | undefined;
  #closed = false;
  #items = 0;

  constructor(launch: ChatDriverStart) {
    this.#launch = launch;
    this.timeline = launch.timeline;
  }

  get sessionId(): string {
    return this.#launch.sessionId;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get args(): string[] {
    return this.#launch.args;
  }

  get state(): ChatSessionState {
    return this.timeline.state;
  }

  get closed(): boolean {
    return this.#closed;
  }

  start(): void {
    // A real, trivial process: the point is that the persisted record names the process this
    // driver holds, as pi's child does, while the record's path and identity stay the service's.
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    this.#child = child;
    if (child.pid !== undefined) this.#launch.writer.record(child.pid);
    this.#launch.onStatus({ state: "idle", updatedAt: Date.now() });
    // The launch prompt, if any, is the first user message — the driver's own rule, as pi's is.
    if (this.#launch.prompt !== null) this.send(this.#launch.prompt, "prompt");
  }

  async stop(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const child = this.#child;
    if (child !== undefined && !hasExited(child)) {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }
    this.#launch.writer.release();
    this.timeline.close();
    this.#launch.onExit(null);
  }

  send(text: string, mode: ChatSendMode): ChatSendReceipt {
    if (mode === "prompt") this.timeline.setState({ turn: "working" });
    this.#items += 1;
    const itemId = `echo-${this.#items}`;
    this.timeline.put({ kind: "user-message", id: itemId, text });
    this.timeline.put({
      kind: "assistant-message",
      id: `${itemId}-answer`,
      text: `echo: ${text}`,
      streaming: false,
    });
    if (mode === "prompt") this.timeline.setState({ turn: "settled" });
    return { id: itemId, outcome: Promise.resolve(null) };
  }

  async abort(): Promise<void> {
    this.timeline.setState({ turn: "aborted" });
  }

  respond(_itemId: string, _value: ChatAnswer): void {}

  async setModel(model: ChatModelRef): Promise<void> {
    const entry = this.timeline.state.models.find(
      (candidate) => candidate.id === model.id && candidate.provider === model.provider,
    );
    this.timeline.setState({
      model: entry ?? { ...model, name: model.id },
      reasoningLevels: entry?.reasoningLevels ?? [],
      reasoning: null,
    });
  }

  async setReasoning(level: string): Promise<void> {
    this.timeline.setState({ reasoning: level });
  }
}

interface Harness {
  registry: ChatDriverRegistry;
  /** Every frontend this registry built, in order: a launch can be counted without a child. */
  started: EchoDriver[];
}

function echoRegistration(started: EchoDriver[]): ChatDriverRegistration {
  return {
    orderedTurnBoundaries: true,
    capabilities: {
      steer: false,
      followUp: false,
      approvals: false,
      modelSwitch: true,
      reasoningLevels: true,
      terminalView: "both-live",
    },
    args: (facts: ChatLaunchFacts) => ["--echo", facts.how, facts.agentSessionId ?? "new"],
    create: (launch) => {
      const driver = new EchoDriver(launch);
      started.push(driver);
      return driver;
    },
  };
}

function echoRegistry(): Harness {
  const started: EchoDriver[] = [];
  return {
    registry: { ...CHAT_DRIVER_REGISTRY, claude: echoRegistration(started) },
    started,
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "corral-chat-driver-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function chatService(harness?: Harness, choices?: MemoryChatChoices): ChatService {
  return new ChatService({
    dataDir: root,
    ...(choices === undefined ? {} : { choices }),
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

/** The first message of a watch, or `done` when the deadline passed with no event at all. */
async function firstMessage(
  service: ChatService,
  sessionId: string,
  kind: "pi" | "claude",
  after?: number,
): Promise<ChatStreamMessage | undefined> {
  const signal = AbortSignal.timeout(2000);
  const watch = service.watch(subject(sessionId, kind), after, signal);
  const first = await watch.next();
  await watch.return(undefined);
  return first.done === true ? undefined : first.value;
}

test("a driver is one registry entry: it answers chat.capabilities and starts through the service", async () => {
  const harness = echoRegistry();
  const chat = chatService(harness);
  try {
    // The record is the driver's declaration, the kind is the registry's key.
    expect(recordsOf(chat.capabilities())).toEqual([
      "claude:both-live:modelSwitch,reasoningLevels",
      "codex:both-live:steer,followUp,approvals,modelSwitch,reasoningLevels",
      "pi:handoff-only:steer,followUp,approvals,modelSwitch,reasoningLevels",
      "opencode:both-live:steer,followUp,approvals,modelSwitch",
    ]);
    expect(chat.hasDriver("claude")).toBe(true);

    await chat.launch(request("echo-1", "claude", "hello"));
    expect(harness.started).toHaveLength(1);

    // The service built the launch: the driver only shapes its own argv, and it saw ours.
    expect(harness.started[0]!.args).toEqual(["--echo", "resume", "conversation-1"]);
    // The release of the prompt is the driver's own rule, as pi's is.
    const first = await firstMessage(chat, "echo-1", "claude");
    expect(first?.type).toBe("snapshot");
    expect(first?.type === "snapshot" ? first.snapshot.items : []).toMatchObject([
      { kind: "user-message", id: "echo-1", text: "hello" },
      { kind: "assistant-message", text: "echo: hello" },
    ]);

    // A send goes through the driver and comes back as an item id, as the contract promises.
    expect(await chat.send(subject("echo-1", "claude"), "again", "steer")).toBe("echo-2");
  } finally {
    await chat.closeAll();
  }
});

test("pi uses the launch snapshot only for a new conversation, not when resuming", () => {
  const facts = {
    model: "first-model",
    provider: "first-provider",
    agentSessionId: "conversation",
  };
  expect(piChatArgs({ ...facts, how: "start" })).toContain("--model");
  const resumed = piChatArgs({ ...facts, how: "resume" });
  expect(resumed).not.toContain("--model");
  expect(resumed).not.toContain("--provider");
});

test("no shipped driver treats uncorrelated native turn events as a verified boundary", () => {
  for (const registration of Object.values(CHAT_DRIVER_REGISTRY)) {
    expect(registration?.orderedTurnBoundaries).not.toBe(true);
  }
});

test("pi does not claim a switched model uses its default when the prior thinking level may persist", async () => {
  const started: EchoDriver[] = [];
  const chat = chatService({ started, registry: { pi: echoRegistration(started) } });
  try {
    await chat.launch(request("pi-default", "pi"));
    const driver = started[0]!;
    driver.timeline.setState({
      model: { provider: "stub", id: "a", name: "A" },
      models: [
        { provider: "stub", id: "a", name: "A" },
        { provider: "stub", id: "b", name: "B" },
      ],
      reasoning: "high",
    });
    driver.setModel = async (model) => {
      driver.timeline.setState({ model: { ...model, name: model.id } });
    };
    await chat.setModel(subject("pi-default", "pi"), { provider: "stub", id: "b" });
    expect(driver.state.model?.id).toBe("b");
    expect(driver.state.reasoning).toBe("high");
    expect(driver.state.selection?.level).toBeNull();
    await expect(
      chat.send(subject("pi-default", "pi"), "native level", "prompt"),
    ).resolves.toBeTruthy();
  } finally {
    await chat.closeAll();
  }
});

test("a model and level are ordered before other clients' sends and switches", async () => {
  const harness = echoRegistry();
  const chat = chatService(harness);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const calls: string[] = [];
  try {
    await chat.launch(request("ordered", "claude"));
    const driver = harness.started[0]!;
    driver.timeline.setState({ reasoningLevels: ["low", "medium", "high"] });
    driver.setModel = async (model) => {
      calls.push(`model:${model.id}`);
      driver.timeline.setState({ model: { ...model, name: model.id } });
      entered.resolve();
      await release.promise;
    };
    driver.setReasoning = async (level) => {
      calls.push(`level:${level}`);
      driver.timeline.setState({ reasoning: level });
    };
    const send = driver.send.bind(driver);
    driver.send = (text, mode) => {
      calls.push(`send:${text}`);
      return send(text, mode);
    };

    const session = subject("ordered", "claude");
    const pair = chat.setModel(session, { provider: null, id: "new" }, "high");
    await entered.promise;
    const message = chat.send(session, "next", "prompt");
    const level = chat.setReasoning(session, "low");
    expect(calls).toEqual(["model:new"]);
    release.resolve();
    await pair;
    await message;
    await level;
    await when(() => calls.includes("level:low"), "the later level at the boundary");
    expect(calls).toEqual(["model:new", "level:high", "send:next", "level:low"]);
    expect(driver.state.model?.id).toBe("new");
    expect(driver.state.reasoning).toBe("low");
  } finally {
    release.resolve();
    await chat.closeAll();
  }
});

test("steer does not wait for a stalled selection command", async () => {
  const harness = echoRegistry();
  const chat = chatService(harness);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await chat.launch(request("steer-unblocked", "claude"));
    const driver = harness.started[0]!;
    const session = subject("steer-unblocked", "claude");
    driver.setModel = async (model) => {
      entered.resolve();
      await release.promise;
      driver.timeline.setState({ model: { ...model, name: model.id } });
    };
    const selection = chat.setModel(session, { provider: "stub", id: "b" });
    await entered.promise;
    expect(await settlesNow(chat.send(session, "steer", "steer"), "the steer")).toBe("echo-1");
    release.resolve();
    await selection;
  } finally {
    release.resolve();
    await chat.closeAll();
  }
});

test("a queued turn whose level disappears before its boundary is not run on another one", async () => {
  const harness = echoRegistry();
  const chat = chatService(harness);
  try {
    await chat.launch(request("queue-level", "claude"));
    const driver = harness.started[0]!;
    const offered = {
      provider: "stub",
      id: "m1",
      name: "M1",
      reasoningLevels: ["low", "high"],
    };
    driver.timeline.setState({
      models: [offered],
      model: { provider: "stub", id: "m1", name: "M1" },
      reasoningLevels: ["low", "high"],
      reasoningStatus: "ready",
      reasoning: "low",
    });
    const session = subject("queue-level", "claude");
    await chat.setReasoning(session, "high");
    // A follow-up waits behind a running turn; the boundary is what would run it.
    driver.timeline.setState({ turn: "working" });
    const id = await chat.send(session, "on high", "follow-up");
    // The next fresh report no longer offers the captured level, before that boundary arrives.
    driver.timeline.setState({
      models: [{ ...offered, reasoningLevels: ["low"] }],
      reasoningLevels: ["low"],
      reasoning: "low",
    });
    const sent: string[] = [];
    const send = driver.send.bind(driver);
    driver.send = (text, mode) => {
      sent.push(text);
      return send(text, mode);
    };
    driver.timeline.setState({ turn: "settled" });

    await expect
      .poll(() => driver.timeline.state.queue?.find((entry) => entry.id === id)?.status, {
        timeout: 2000,
        message: "the undelivered queue entry",
      })
      .toBe("undelivered");
    expect(sent).toEqual([]);
    expect(driver.timeline.state.followUp).toEqual([]);
    expect(
      driver.timeline.snapshot().items.find((item) => item.id === `chat:queue:${id}`),
    ).toMatchObject({ kind: "error" });
  } finally {
    await chat.closeAll();
  }
});

/** A frontend whose live report offers `max`, the starting point a stale level needs. */
async function maxFrontend(sessionId: string) {
  const harness = echoRegistry();
  const chat = chatService(harness);
  await chat.launch(request(sessionId, "claude"));
  const driver = harness.started[0]!;
  const model = { provider: "stub", id: "m1", name: "M1", reasoningLevels: ["low", "max"] };
  driver.timeline.setState({
    models: [model],
    model: { provider: "stub", id: "m1", name: "M1" },
    reasoningLevels: ["low", "max"],
    reasoningStatus: "ready",
    reasoning: "max",
  });
  const session = subject(sessionId, "claude");
  await chat.setReasoning(session, "max");
  return { chat, driver, session };
}

test("a cached level in a failed report is unconfirmed: not applied and not removed", async () => {
  const { chat, driver, session } = await maxFrontend("stale-level");
  const sent: string[] = [];
  const echoed = driver.send.bind(driver);
  driver.send = (text, mode) => {
    sent.push(text);
    return echoed(text, mode);
  };
  const applied: string[] = [];
  driver.setReasoning = async (level) => {
    applied.push(level);
    driver.timeline.setState({ reasoning: level });
  };
  try {
    // The list still holds max, but the refresh that would prove the model offers it failed.
    driver.timeline.setState({ reasoningStatus: "error" });
    await expect(chat.send(session, "on max?", "prompt")).rejects.toBeInstanceOf(
      ChatReasoningUnsupportedError,
    );
    // The choice is kept, and it is the cached list that is not evidence — neither of the level nor
    // of a removal.
    expect(driver.timeline.state.selection).toEqual({
      model: { provider: "stub", id: "m1" },
      level: "max",
    });
    expect(driver.timeline.state.selectionIssue).toEqual({ level: "max", reason: "unconfirmed" });
    expect(driver.timeline.state.reasoningLevels).toContain("max");
    expect(applied).toEqual([]);
    expect(sent).toEqual([]);

    // A refresh still in flight is the same: a cached level is not evidence until the report lands.
    driver.timeline.setState({ reasoningStatus: "loading" });
    await expect(chat.send(session, "on max now?", "prompt")).rejects.toBeInstanceOf(
      ChatReasoningUnsupportedError,
    );
    expect(driver.timeline.state.selectionIssue).toEqual({ level: "max", reason: "unconfirmed" });
    expect(sent).toEqual([]);
  } finally {
    await chat.closeAll();
  }
});

test("a fresh report decides the level: offering it runs the turn, a list without it is unavailable", async () => {
  const { chat, driver, session } = await maxFrontend("fresh-level");
  const sent: string[] = [];
  const echoed = driver.send.bind(driver);
  driver.send = (text, mode) => {
    sent.push(text);
    return echoed(text, mode);
  };
  try {
    driver.timeline.setState({ reasoningStatus: "error" });
    await expect(chat.send(session, "too early", "prompt")).rejects.toBeInstanceOf(
      ChatReasoningUnsupportedError,
    );
    // A fresh report that still offers the level returns the choice without a new user action.
    driver.timeline.setState({ reasoningStatus: "ready" });
    await chat.send(session, "on max", "prompt");
    expect(sent).toEqual(["on max"]);
    expect(driver.timeline.state.selectionIssue).toBeNull();

    // A fresh list that lacks it is an unavailable one, and the words do not leave.
    driver.timeline.setState({
      reasoningLevels: ["low"],
      reasoning: "low",
      reasoningStatus: "ready",
    });
    await expect(chat.send(session, "must not leave", "prompt")).rejects.toBeInstanceOf(
      ChatReasoningUnsupportedError,
    );
    expect(driver.timeline.state.selection).toEqual({
      model: { provider: "stub", id: "m1" },
      level: "max",
    });
    expect(driver.timeline.state.selectionIssue).toEqual({ level: "max", reason: "unavailable" });
    expect(sent).toEqual(["on max"]);
  } finally {
    await chat.closeAll();
  }
});

test("a degraded report does not make another model's cached list a fresh one", async () => {
  const harness = echoRegistry();
  const chat = chatService(harness);
  try {
    await chat.launch(request("other-model-level", "claude"));
    const driver = harness.started[0]!;
    const running = { provider: "stub", id: "m1", name: "M1", reasoningLevels: ["low"] };
    const other = { provider: "stub", id: "m2", name: "M2", reasoningLevels: ["low", "max"] };
    driver.timeline.setState({
      models: [running, other],
      model: { provider: "stub", id: "m1", name: "M1" },
      reasoningLevels: ["low"],
      reasoningStatus: "ready",
      reasoning: "low",
      turn: "working",
    });
    // The catalog still lists max on m2, but the live report that would prove the levels is failed.
    driver.timeline.setState({ reasoningStatus: "error" });
    await expect(
      chat.setModel(subject("other-model-level", "claude"), { provider: "stub", id: "m2" }, "max"),
    ).rejects.toBeInstanceOf(ChatReasoningUnsupportedError);
  } finally {
    await chat.closeAll();
  }
});

/** Waits for an observable state, failing on a deadline instead of hanging. */
async function when(predicate: () => boolean, description: string): Promise<void> {
  await expect.poll(predicate, { timeout: 2000, message: description }).toBe(true);
}

/** Fails the test instead of hanging when a call that must not wait never settles. */
function settlesNow<T>(promise: Promise<T>, description: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(
        () => reject(new Error(`${description} waited on a delivery receipt`)),
        1000,
      ).unref();
    }),
  ]);
}

test("an unconfirmed delivery does not hold a steer, a later choice or a stop", async () => {
  const harness = echoRegistry();
  const choices = new MemoryChatChoices();
  const chat = chatService(harness, choices);
  const outstanding = Promise.withResolvers<Error | null>();
  try {
    await chat.launch(request("pending-delivery", "claude"));
    const driver = harness.started[0]!;
    const session = subject("pending-delivery", "claude");
    const echoed = driver.send.bind(driver);
    const sent: string[] = [];
    driver.send = (text, mode) => {
      const receipt = echoed(text, mode);
      const first = sent.length === 0;
      sent.push(text);
      return first ? { ...receipt, outcome: outstanding.promise } : receipt;
    };

    const id = await chat.send(session, "queued one", "follow-up");
    await when(() => sent.length === 1, "the queued send");
    expect(driver.timeline.state.queue?.find((entry) => entry.id === id)?.status).toBe("sending");

    // The boundary pass released the serial queue, so nothing else waits on the receipt.
    await settlesNow(chat.send(session, "steer", "steer"), "the steer");
    await settlesNow(chat.setModel(session, { provider: "stub", id: "m2" }), "the later choice");
    await settlesNow(chat.stop("pending-delivery"), "the stop");

    // The stop already settled the attempt; its late answer cannot claim it was sent.
    outstanding.resolve(null);
    await when(
      () =>
        choices.queue("pending-delivery").find((entry) => entry.id === id)?.status === "uncertain",
      "the row the stop left uncertain",
    );
  } finally {
    outstanding.resolve(null);
    await chat.closeAll();
  }
});

test("the next queued entry waits for the first attempt's receipt, not just its visible turn", async () => {
  const harness = echoRegistry();
  const choices = new MemoryChatChoices();
  const chat = chatService(harness, choices);
  const outstanding = Promise.withResolvers<Error | null>();
  try {
    await chat.launch(request("pending-boundary", "claude"));
    const driver = harness.started[0]!;
    const session = subject("pending-boundary", "claude");
    const echoed = driver.send.bind(driver);
    const sent: string[] = [];
    driver.send = (text, mode) => {
      const receipt = echoed(text, mode);
      const first = sent.length === 0;
      sent.push(text);
      return first ? { ...receipt, outcome: outstanding.promise } : receipt;
    };

    const firstId = await chat.send(session, "first", "follow-up");
    await when(() => sent.length === 1, "the first send");
    await chat.send(session, "second", "follow-up");
    // A choice is a barrier on the same serial queue: when it settles, the pass the second entry
    // queued has already run and had its chance to send.
    await chat.setModel(session, { provider: "stub", id: "m2" });
    expect(sent).toEqual(["first"]);

    // The turn the first attempt opened is visible, and its settled boundary arrives before the
    // agent has named the message. The second entry must not run ahead of that unconfirmed one.
    driver.timeline.setState({ turn: "working" });
    driver.timeline.setState({ turn: "settled" });
    await chat.setModel(session, { provider: "stub", id: "m3" });
    expect(sent).toEqual(["first"]);
    expect(choices.queue("pending-boundary").find((entry) => entry.id === firstId)?.status).toBe(
      "sending",
    );

    outstanding.resolve(null);
    await when(() => sent.length === 2, "the second send after the first was confirmed");
    expect(sent).toEqual(["first", "second"]);
  } finally {
    outstanding.resolve(null);
    await chat.closeAll();
  }
});

test("an unknown delivery cannot release a later model or queued turn before delayed working", async () => {
  const harness = echoRegistry();
  const choices = new MemoryChatChoices();
  const chat = chatService(harness, choices);
  const outcome = Promise.withResolvers<Error | null>();
  try {
    await chat.launch(request("delayed-working", "claude"));
    const driver = harness.started[0]!;
    const session = subject("delayed-working", "claude");
    const models = [
      { provider: "stub", id: "a", name: "A" },
      { provider: "stub", id: "b", name: "B" },
    ];
    driver.timeline.setState({ model: models[0]!, models });
    const sent: string[] = [];
    driver.send = (text) => {
      sent.push(text);
      return { id: text, outcome: outcome.promise };
    };
    await chat.send(session, "A", "follow-up");
    await when(() => sent.length === 1, "A delivered to the fake transport");
    await chat.setModel(session, { provider: "stub", id: "b" });
    await chat.send(session, "B", "follow-up");
    outcome.resolve(new Error("connection lost after delivery"));
    await when(
      () => choices.queue("delayed-working").some((entry) => entry.status === "uncertain"),
      "A marked uncertain",
    );
    await chat.setModel(session, { provider: "stub", id: "a" });
    expect(sent).toEqual(["A"]);
    expect(driver.state.model?.id).toBe("a");
    driver.timeline.setState({ turn: "working" });
    expect(sent).toEqual(["A"]);
  } finally {
    outcome.resolve(null);
    await chat.closeAll();
  }
});

test.each(["error-first", "boundary-first"] as const)(
  "a correlated boundary recovers a lost receipt regardless of ordering: %s",
  async (order) => {
    const harness = echoRegistry();
    const choices = new MemoryChatChoices();
    const chat = chatService(harness, choices);
    const outcome = Promise.withResolvers<Error | null>();
    const boundary = Promise.withResolvers<"settled" | "aborted">();
    try {
      await chat.launch(request("recovered-delivery", "claude"));
      const driver = harness.started[0]!;
      const session = subject("recovered-delivery", "claude");
      const sent: string[] = [];
      driver.send = (text) => {
        sent.push(text);
        return sent.length === 1
          ? { id: text, outcome: outcome.promise, boundary: boundary.promise }
          : { id: text, outcome: Promise.resolve(null) };
      };
      await chat.send(session, "A", "prompt");
      await chat.send(session, "B", "follow-up");
      if (order === "error-first") {
        outcome.resolve(new Error("reply lost"));
        await when(
          () => choices.queue(session.sessionId)[0]?.status === "uncertain",
          "unknown delivery",
        );
      } else {
        boundary.resolve("settled");
        await Promise.resolve();
      }
      expect(sent).toEqual(["A"]);
      if (order === "error-first") boundary.resolve("settled");
      else outcome.resolve(new Error("reply lost"));
      await when(() => sent.length === 2, "the later turn after correlated evidence");
      expect(sent).toEqual(["A", "B"]);
    } finally {
      outcome.resolve(null);
      boundary.resolve("settled");
      await chat.closeAll();
    }
  },
);

test("an accepted queued prompt does not establish a turn boundary before working arrives", async () => {
  const harness = echoRegistry();
  const choices = new MemoryChatChoices();
  const chat = chatService(harness, choices);
  const outcome = Promise.withResolvers<Error | null>();
  try {
    await chat.launch(request("accepted-before-working", "claude"));
    const driver = harness.started[0]!;
    const session = subject("accepted-before-working", "claude");
    const models = [
      { provider: "stub", id: "a", name: "A" },
      { provider: "stub", id: "b", name: "B" },
    ];
    driver.timeline.setState({ model: models[0]!, models });
    const sent: string[] = [];
    driver.send = (text) => {
      sent.push(text);
      return { id: text, outcome: outcome.promise };
    };
    await chat.send(session, "A", "follow-up");
    await when(() => sent.length === 1, "A delivered to the fake transport");
    await chat.send(session, "B", "follow-up");
    outcome.resolve(null);
    await Promise.resolve();
    await chat.setModel(session, { provider: "stub", id: "b" });
    expect(sent).toEqual(["A"]);
    expect(driver.state.model?.id).toBe("a");
  } finally {
    outcome.resolve(null);
    await chat.closeAll();
  }
});

test("a direct prompt holds later model changes before working arrives", async () => {
  const harness = echoRegistry();
  const chat = chatService(harness);
  const outcome = Promise.withResolvers<Error | null>();
  try {
    await chat.launch(request("prompt-before-working", "claude"));
    const driver = harness.started[0]!;
    const session = subject("prompt-before-working", "claude");
    const models = [
      { provider: "stub", id: "a", name: "A" },
      { provider: "stub", id: "b", name: "B" },
    ];
    driver.timeline.setState({ model: models[0]!, models });
    driver.send = (text) => ({ id: text, outcome: outcome.promise });
    await chat.send(session, "A", "prompt");
    await chat.setModel(session, { provider: "stub", id: "b" });
    expect(driver.state.model?.id).toBe("a");
  } finally {
    outcome.resolve(null);
    await chat.closeAll();
  }
});

test("an accepted delivery releases the captured next turn only after its own working and settled events", async () => {
  const harness = echoRegistry();
  const chat = chatService(harness);
  const first = Promise.withResolvers<Error | null>();
  try {
    await chat.launch(request("accepted-boundary", "claude"));
    const driver = harness.started[0]!;
    const session = subject("accepted-boundary", "claude");
    const models = [
      { provider: "stub", id: "a", name: "A" },
      { provider: "stub", id: "b", name: "B" },
    ];
    driver.timeline.setState({ model: models[0]!, models });
    const sent: Array<{ text: string; model: string | undefined }> = [];
    driver.send = (text) => {
      sent.push({ text, model: driver.state.model?.id });
      return { id: text, outcome: sent.length === 1 ? first.promise : Promise.resolve(null) };
    };
    await chat.send(session, "A", "prompt");
    await chat.setModel(session, { provider: "stub", id: "b" });
    await chat.send(session, "B", "follow-up");
    first.resolve(null);
    await Promise.resolve();
    driver.timeline.setState({ turn: "working" });
    await chat.setModel(session, { provider: "stub", id: "a" });
    expect(sent).toEqual([{ text: "A", model: "a" }]);
    driver.timeline.setState({ turn: "settled" });
    await when(() => sent.length === 2, "the captured next turn");
    expect(sent).toEqual([
      { text: "A", model: "a" },
      { text: "B", model: "b" },
    ]);
  } finally {
    first.resolve(null);
    await chat.closeAll();
  }
});

test("an uncertain direct prompt survives restart and blocks both clients without blocking steer", async () => {
  const harness = echoRegistry();
  const choices = new MemoryChatChoices();
  const chat = chatService(harness, choices);
  const first = Promise.withResolvers<Error | null>();
  try {
    await chat.launch(request("unknown-restart", "claude"));
    const driver = harness.started[0]!;
    const session = subject("unknown-restart", "claude");
    const sent: string[] = [];
    driver.send = (text) => {
      sent.push(text);
      return { id: text, outcome: sent.length === 1 ? first.promise : Promise.resolve(null) };
    };
    await chat.send(session, "A", "prompt");
    first.resolve(new Error("lost after delivery"));
    await when(
      () => choices.queue(session.sessionId).some((e) => e.status === "uncertain"),
      "unknown delivery",
    );
    await chat.send(session, "steer", "steer");
    await chat.send(session, "B", "follow-up");
    driver.timeline.setState({ turn: "working" });
    driver.timeline.setState({ turn: "settled" });
    await chat.setModel(session, { provider: "stub", id: "b" });
    expect(sent).toEqual(["A", "steer"]);
    await chat.stop(session.sessionId);
    await chat.launch(request(session.sessionId, "claude"));
    const resumed = harness.started[1]!;
    const resumedSent: string[] = [];
    resumed.send = (text) => {
      resumedSent.push(text);
      return { id: text, outcome: Promise.resolve(null) };
    };
    resumed.timeline.setState({
      model: { provider: "stub", id: "a", name: "A" },
      models: [{ provider: "stub", id: "b", name: "B" }],
    });
    await chat.send(session, "C", "follow-up");
    await expect(chat.send(session, "D", "prompt")).rejects.toMatchObject({
      reason: "turn-unconfirmed",
    });
    expect(resumedSent).toEqual([]);
    expect(resumed.state.model?.id).toBe("a");
    expect(choices.queue(session.sessionId).find((entry) => entry.text === "A")?.status).toBe(
      "uncertain",
    );
    expect(
      resumed.timeline
        .snapshot()
        .items.some((item) => item.kind === "error" && item.text.includes("A")),
    ).toBe(true);
  } finally {
    first.resolve(null);
    await chat.closeAll();
  }
});

test("an initial prompt is recorded before delivery and is never replayed on resume", async () => {
  const choices = new MemoryChatChoices();
  const started: EchoDriver[] = [];
  const sent: string[] = [];
  const registration = echoRegistration(started);
  const chat = chatService(
    {
      started,
      registry: {
        claude: {
          ...registration,
          create: (launch) => {
            const driver = new EchoDriver({ ...launch, prompt: null });
            started.push(driver);
            const start = driver.start.bind(driver);
            driver.start = () => {
              start();
              launch.sendInitialPrompt?.(launch.prompt);
            };
            driver.send = (text) => {
              sent.push(text);
              driver.timeline.setState({ turn: "working" });
              driver.timeline.setState({ turn: "settled" });
              return { id: text, outcome: Promise.resolve(null) };
            };
            return driver;
          },
        },
      },
    },
    choices,
  );
  try {
    const launch = request("initial-once", "claude", "initial words");
    await chat.launch({ ...launch, how: "start" });
    await when(
      () => choices.queue(launch.sessionId).some((entry) => entry.status === "completed"),
      "the completed initial prompt",
    );
    expect(sent).toEqual(["initial words"]);
    await chat.stop(launch.sessionId);
    await chat.launch({ ...launch, how: "resume" });
    await when(
      () =>
        started[1]!.timeline
          .snapshot()
          .items.some((item) => item.kind === "error" && item.text.includes("not sent again")),
      "the withheld replay",
    );
    expect(sent).toEqual(["initial words"]);
  } finally {
    await chat.closeAll();
  }
});

test("a resumed frontend hands over a task prompt the agent never received", async () => {
  const choices = new MemoryChatChoices();
  const started: EchoDriver[] = [];
  const sent: string[] = [];
  const registration = echoRegistration(started);
  const chat = chatService(
    {
      started,
      registry: {
        claude: {
          ...registration,
          create: (launch) => {
            const driver = new EchoDriver({ ...launch, prompt: null });
            started.push(driver);
            const start = driver.start.bind(driver);
            driver.start = () => {
              start();
              launch.sendInitialPrompt?.(launch.prompt);
            };
            driver.send = (text) => {
              sent.push(text);
              driver.timeline.setState({ turn: "working" });
              driver.timeline.setState({ turn: "settled" });
              return { id: text, outcome: Promise.resolve(null) };
            };
            return driver;
          },
        },
      },
    },
    choices,
  );
  try {
    // The terminal that started the task left no chat record and the agent reports an empty
    // history: a resume is no evidence that the prompt was delivered.
    const launch = request("initial-handoff", "claude", "initial words");
    await chat.launch(launch);
    await when(
      () => choices.queue(launch.sessionId).some((entry) => entry.status === "completed"),
      "the handed-over prompt",
    );
    expect(sent).toEqual(["initial words"]);
    await chat.stop(launch.sessionId);
    await chat.launch(launch);
    await when(
      () =>
        started[1]!.timeline
          .snapshot()
          .items.some((item) => item.kind === "error" && item.text.includes("not sent again")),
      "the withheld replay",
    );
    expect(sent).toEqual(["initial words"]);
  } finally {
    await chat.closeAll();
  }
});

test("a both-live native terminal holds prompt and model application without blocking steer", async () => {
  const harness = echoRegistry();
  const chat = chatService(harness);
  let terminalLive = true;
  try {
    await chat.launch({
      ...request("native-writer", "claude"),
      terminalLive: () => terminalLive,
    });
    const driver = harness.started[0]!;
    const session = subject("native-writer", "claude");
    driver.timeline.setState({
      model: { provider: "stub", id: "a", name: "A" },
      models: [{ provider: "stub", id: "b", name: "B" }],
    });
    await chat.setModel(session, { provider: "stub", id: "b" });
    expect(driver.state.model?.id).toBe("a");
    await expect(chat.send(session, "next", "prompt")).rejects.toMatchObject({
      reason: "turn-unconfirmed",
    });
    await expect(chat.send(session, "steer", "steer")).resolves.toBeDefined();
    terminalLive = false;
    await chat.send(session, "next", "prompt");
    expect(driver.state.model?.id).toBe("b");
  } finally {
    await chat.closeAll();
  }
});

test("an agent without ordered turn boundaries cannot release a later turn on stale events", async () => {
  const started: EchoDriver[] = [];
  const choices = new MemoryChatChoices();
  const chat = chatService(
    {
      started,
      registry: {
        claude: { ...echoRegistration(started), orderedTurnBoundaries: false },
      },
    },
    choices,
  );
  try {
    await chat.launch(request("unverified-events", "claude"));
    const driver = started[0]!;
    const session = subject("unverified-events", "claude");
    const sent: string[] = [];
    driver.send = (text) => {
      sent.push(text);
      return { id: text, outcome: Promise.resolve(null) };
    };
    await chat.send(session, "A", "prompt");
    await when(
      () => choices.queue(session.sessionId)[0]?.status === "boundary-unverified",
      "the unsupported boundary",
    );
    await chat.send(session, "B", "follow-up");
    driver.timeline.setState({ turn: "working" });
    driver.timeline.setState({ turn: "settled" });
    await chat.setModel(session, { provider: "stub", id: "b" });
    expect(sent).toEqual(["A"]);
    expect(
      driver.timeline
        .snapshot()
        .items.some(
          (item) =>
            item.kind === "error" && item.text.includes("boundary cannot currently be confirmed"),
        ),
    ).toBe(true);
  } finally {
    await chat.closeAll();
  }
});

test("a late receipt after abort cannot release an uncertain attempt", async () => {
  const harness = echoRegistry();
  const choices = new MemoryChatChoices();
  const chat = chatService(harness, choices);
  const stale = Promise.withResolvers<Error | null>();
  try {
    await chat.launch(request("stale-receipt", "claude"));
    const driver = harness.started[0]!;
    const session = subject("stale-receipt", "claude");
    const echoed = driver.send.bind(driver);
    const sent: string[] = [];
    driver.send = (text, mode) => {
      const receipt = echoed(text, mode);
      const index = sent.length;
      sent.push(text);
      if (index === 0) return { ...receipt, outcome: stale.promise };
      return receipt;
    };

    const firstId = await chat.send(session, "first", "follow-up");
    await when(() => sent.length === 1, "the first send");
    driver.timeline.setState({ turn: "working" });
    await chat.abort(session);
    await when(
      () =>
        choices.queue("stale-receipt").find((entry) => entry.id === firstId)?.status ===
        "uncertain",
      "the halted attempt",
    );

    await chat.send(session, "second", "follow-up");
    stale.resolve(null);
    await Promise.resolve();
    await chat.send(session, "third", "follow-up");
    await chat.setModel(session, { provider: "stub", id: "m2" });
    expect(sent).toEqual(["first"]);
    expect(choices.queue("stale-receipt").find((entry) => entry.id === firstId)?.status).toBe(
      "uncertain",
    );
  } finally {
    stale.resolve(null);
    await chat.closeAll();
  }
});

test("an abort while a delivery is unconfirmed leaves it uncertain, and a late refusal cannot rewrite it", async () => {
  const harness = echoRegistry();
  const choices = new MemoryChatChoices();
  const chat = chatService(harness, choices);
  const outstanding = Promise.withResolvers<Error | null>();
  try {
    await chat.launch(request("abort-race", "claude"));
    const driver = harness.started[0]!;
    const session = subject("abort-race", "claude");
    const echoed = driver.send.bind(driver);
    driver.send = (text, mode) => ({ ...echoed(text, mode), outcome: outstanding.promise });

    const id = await chat.send(session, "racing", "follow-up");
    await when(
      () =>
        driver.timeline.state.queue?.some(
          (entry) => entry.id === id && entry.status === "sending",
        ) === true,
      "the attempt in flight",
    );
    // The turn the attempt opened is running when the user aborts it.
    driver.timeline.setState({ turn: "working" });
    await chat.abort(session);
    await when(
      () => choices.queue("abort-race").find((entry) => entry.id === id)?.status === "uncertain",
      "the aborted attempt",
    );

    // A refusal that arrives after the abort cannot downgrade the row to "certainly unsent".
    outstanding.resolve(new ChatRefusalError("the agent said no after the abort"));
    await new Promise((settle) => setTimeout(settle, 0));
    expect(choices.queue("abort-race").find((entry) => entry.id === id)?.status).toBe("uncertain");
  } finally {
    outstanding.resolve(new ChatRefusalError("cleanup"));
    await chat.closeAll();
  }
});

test("a model change completing after the frontend stops cannot append to its closed timeline", async () => {
  const harness = echoRegistry();
  const chat = chatService(harness);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    await chat.launch(request("stopped-during-choice", "claude"));
    const driver = harness.started[0]!;
    driver.setModel = async () => {
      entered.resolve();
      await release.promise;
    };
    const pair = chat.setModel(
      subject("stopped-during-choice", "claude"),
      { provider: null, id: "new" },
      "high",
    );
    await entered.promise;
    await chat.stop("stopped-during-choice");
    const lastSequence = driver.timeline.sequence;
    release.resolve();
    await expect(pair).rejects.toThrow("the chat frontend was stopped");
    expect(driver.timeline.sequence).toBe(lastSequence);
  } finally {
    release.resolve();
    await chat.closeAll();
  }
});

test("the registry refuses an agent kind this build has no driver for", async () => {
  const harness = echoRegistry();
  // A build without the Codex driver: the registry is the one fact the service consults.
  const registry = { ...harness.registry };
  delete registry.codex;
  const chat = chatService({ ...harness, registry });
  try {
    // `codex` is an agent kind without a driver here: the refusal names it, nothing is claimed.
    await expect(chat.launch(request("echo-2", "codex"))).rejects.toThrow(ChatLaunchError);
    await expect(chat.launch(request("echo-2", "codex"))).rejects.toThrow(
      "the codex agent has no chat driver in this build",
    );
    expect(harness.started).toHaveLength(0);
    // The build's own registry ships claude, codex, pi and opencode; the seam is what added claude.
    expect(recordsOf(chatService().capabilities())).toEqual([
      "claude:handoff-only:steer,followUp,approvals,modelSwitch,reasoningLevels",
      "codex:both-live:steer,followUp,approvals,modelSwitch,reasoningLevels",
      "pi:handoff-only:steer,followUp,approvals,modelSwitch,reasoningLevels",
      "opencode:both-live:steer,followUp,approvals,modelSwitch",
    ]);
  } finally {
    await chat.closeAll();
  }
});

test("one writer per session is the service's, and the driver only reports its process", async () => {
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

    // The record this frontend lives under is the service's path, written by the service's
    // `record` with the pid the driver reported — the trivial driver has no record code of its own.
    const record: unknown = JSON.parse(
      await readFile(writerPath(`${root}/chat`, "echo-3"), "utf8"),
    );
    // The pid the driver reported and the start time the service read: one record, two facts.
    expect(record).toEqual({
      pid: harness.started[0]!.pid,
      startedAt: expect.any(Number),
      identity: expect.any(String),
    });

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

    // A stop releases the record through the same pair, so the next launch has nothing to kill.
    await chat.stop("echo-3");
    await expect(readFile(writerPath(`${root}/chat`, "echo-3"), "utf8")).rejects.toThrow(
      "no such file or directory",
    );
  } finally {
    kill(sleeper);
    await chat.closeAll();
  }
});

test("the timeline's start and the exit bookkeeping stay outside the driver", async () => {
  const harness = echoRegistry();
  const chat = chatService(harness);
  try {
    await chat.launch(request("echo-5", "claude"));
    // The service built the timeline from the reservation it persisted before the driver existed.
    expect(harness.started[0]!.timeline.sequence).toBe(0);
    expect(readFloor(floorPath(`${root}/chat`, "echo-5"))).toBe(SEQUENCE_BLOCK);

    await chat.send(subject("echo-5", "claude"), "one", "prompt");
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

test("a cursor held from a replaced frontend gets a snapshot, not a replay", async () => {
  const harness = echoRegistry();
  const chat = chatService(harness);
  try {
    await chat.launch(request("echo-6", "claude"));
    await chat.send(subject("echo-6", "claude"), "one", "prompt");
    await chat.send(subject("echo-6", "claude"), "two", "prompt");
    const cursor = harness.started[0]!.timeline.sequence;
    expect(cursor).toBeGreaterThan(0);
    await chat.stop("echo-6");

    // The session starts again (a restart, a handoff back, a server that came back): this timeline
    // is above the floor the first one reserved, so the old cursor is a hole — a snapshot.
    await chat.launch(request("echo-6", "claude"));
    // The client's symptom first: the stale cursor is answered with a snapshot, never silence.
    const first = await firstMessage(chat, "echo-6", "claude", cursor);
    expect(first?.type).toBe("snapshot");
    expect(first?.type === "snapshot" ? first.snapshot.sequence : -1).toBeGreaterThan(cursor);
    // And the mechanism: the new timeline starts above the floor the first frontend reserved.
    expect(harness.started[1]!.timeline.sequence).toBeGreaterThanOrEqual(SEQUENCE_BLOCK);
  } finally {
    await chat.closeAll();
  }
});

test("a driver that brings its own timeline is refused instead of replaying a stale cursor", async () => {
  const started: EchoDriver[] = [];
  const rogue: ChatDriverRegistration = {
    ...echoRegistration(started),
    // Ignores the timeline it was handed, as a driver that copied the old `startAt` would.
    create: (launch) => {
      const driver = new EchoDriver({ ...launch, timeline: new ChatTimeline(0) });
      started.push(driver);
      return driver;
    },
  };
  const chat = chatService({ registry: { ...CHAT_DRIVER_REGISTRY, claude: rogue }, started });
  try {
    await expect(chat.launch(request("echo-7", "claude"))).rejects.toThrow(
      "the claude chat driver did not use the timeline it was given",
    );
    // A refused launch leaves nothing behind: the same id may be launched again.
    await expect(chat.launch(request("echo-7", "claude"))).rejects.toThrow(
      "the claude chat driver did not use the timeline it was given",
    );
    expect(started).toHaveLength(2);
  } finally {
    await chat.closeAll();
  }
});

test("a driver whose start throws frees the session id and reports the reason", async () => {
  const broken: ChatDriverRegistration = {
    capabilities: {
      steer: false,
      followUp: false,
      approvals: false,
      modelSwitch: false,
      reasoningLevels: false,
      terminalView: "handoff-only",
    },
    args: () => [],
    create: (launch) => {
      const driver = new EchoDriver(launch);
      return Object.assign(driver, {
        start: () => {
          throw new Error("the driver fell over");
        },
      });
    },
  };
  const chat = chatService({ registry: { ...CHAT_DRIVER_REGISTRY, claude: broken }, started: [] });
  try {
    // A start that throws is an exit, not a stuck claim: the launch settles and the id is free.
    await chat.launch(request("echo-8", "claude"));
    await chat.launch(request("echo-8", "claude"));
    // The reason is what a client reads, with the service's own `exited` vocabulary.
    expect(() => chat.send(subject("echo-8", "claude"), "hello", "prompt")).toThrow(
      "the driver fell over",
    );
    expect(() => chat.send(subject("echo-8", "claude"), "hello", "prompt")).toThrow(
      ChatUnavailableError,
    );
  } finally {
    await chat.closeAll();
  }
});

/** Each capability record as one line, so a diff shows which driver changed what. */
function recordsOf(records: ChatDriverCapabilities[]): string[] {
  return records.map(({ kind, terminalView, ...flags }) => {
    const on = Object.entries(flags)
      .filter(([, value]) => value)
      .map(([name]) => name);
    return `${kind}:${terminalView}:${on.join(",")}`;
  });
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
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
  if (hasExited(child)) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 1000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}
