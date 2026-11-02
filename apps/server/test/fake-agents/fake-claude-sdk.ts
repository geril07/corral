import type {
  EffortLevel,
  ModelInfo,
  Options,
  SDKMessage,
  SDKUserMessage,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSdk, ClaudeSdkQuery } from "../../src/chat/claude-driver.ts";

/**
 * A stand-in for `@anthropic-ai/claude-agent-sdk`: the driver's own seam (`ClaudeSdk`), not a mock
 * of our code. It journals the options the driver chose, serves a canned transcript, and lets a
 * test script the stream-json messages the SDK would emit — so a suite can drive a whole turn,
 * a permission round trip, a model switch and a crash without the user's login and without a model
 * call.
 *
 * When `spawnChild` is on, the fake calls the driver's `spawnClaudeCodeProcess` hook with a
 * placeholder child that reads stdin (the real SDK's contract for that hook), so the driver records
 * a real pid as the session's writer and a stop/handoff test observes real process death. The fake
 * never talks to that child; it stands in for the CLI process, not for its protocol.
 */
export class FakeClaudeSdk implements ClaudeSdk {
  /** One entry per `query()`, in start order. */
  readonly queries: FakeClaudeQuery[] = [];
  /** The options of every `query()` the driver made. */
  readonly options: Options[] = [];
  /** Every `getSessionMessages` call, so a test can assert the id and project dir it was given. */
  readonly historyCalls: { sessionId: string; dir: string | undefined }[] = [];
  readonly models: ModelInfo[];
  #history: SessionMessage[];
  #historyFails: boolean;
  #modelsFails: string | undefined;
  #spawnChild: boolean;
  #stubbornChild: boolean;
  #silent: boolean;
  #modelsHang: boolean;
  #crash: string | undefined;
  #turn: ((query: FakeClaudeQuery, text: string) => void) | undefined;

  constructor(
    options: {
      history?: SessionMessage[];
      models?: ModelInfo[];
      /** Fail the transcript read, as an unreadable config directory would. */
      historyFails?: boolean;
      /** Reject `supportedModels()` with this message, as an SDK resume of a missing id does. */
      modelsFails?: string;
      /** Spawn the placeholder child through the driver's own spawn hook. */
      spawnChild?: boolean;
      /** The placeholder ignores stdin EOF and SIGTERM, so only the driver's group kill ends it. */
      stubbornChild?: boolean;
      /** Emit no `init` frame (the CLI does that with the first turn), as the real one may not. */
      silent?: boolean;
      /** Never answer `supportedModels()`: the ready deadline must fail the frontend. */
      modelsHang?: boolean;
      /** Throw from the message iterator after the scripted messages, as a crash would. */
      crash?: string;
      /** What the fake does when a user message arrives; the default answers text and a result. */
      turn?: (query: FakeClaudeQuery, text: string) => void;
    } = {},
  ) {
    this.#history = options.history ?? [];
    this.models = options.models ?? DEFAULT_MODELS;
    this.#historyFails = options.historyFails ?? false;
    this.#modelsFails = options.modelsFails;
    this.#spawnChild = options.spawnChild ?? false;
    this.#stubbornChild = options.stubbornChild ?? false;
    this.#silent = options.silent ?? false;
    this.#modelsHang = options.modelsHang ?? false;
    this.#crash = options.crash;
    this.#turn = options.turn;
  }

  query(params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }): ClaudeSdkQuery {
    const options = params.options ?? {};
    this.options.push(options);
    const query = new FakeClaudeQuery(this, options, params.prompt, {
      spawnChild: this.#spawnChild,
      stubbornChild: this.#stubbornChild,
      silent: this.#silent,
      modelsHang: this.#modelsHang,
      modelsFails: this.#modelsFails,
      crash: this.#crash,
      turn: this.#turn,
    });
    this.queries.push(query);
    return query;
  }

  async getSessionMessages(
    sessionId: string,
    options?: { dir?: string },
  ): Promise<SessionMessage[]> {
    this.historyCalls.push({ sessionId, dir: options?.dir });
    if (this.#historyFails) throw new Error("the transcript could not be read");
    return this.#history;
  }

  /** The query a driver is talking to (one launch has one). */
  get onlyQuery(): FakeClaudeQuery {
    const query = this.queries[0];
    if (query === undefined) throw new Error("the driver did not create a query");
    return query;
  }

  /** Waits until the driver has read the transcript `count` times. */
  async whenHistoryRead(count = 1, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.historyCalls.length < count) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} history read(s)`);
      // oxlint-disable-next-line no-await-in-loop -- one poll per tick until the read lands
      await new Promise((settle) => setTimeout(settle, 5));
    }
  }
}

export interface FakeClaudeQueryOptions {
  spawnChild: boolean;
  stubbornChild: boolean;
  silent: boolean;
  modelsHang: boolean;
  modelsFails: string | undefined;
  crash: string | undefined;
  turn: ((query: FakeClaudeQuery, text: string) => void) | undefined;
}

/** One query: the driver's options, the messages it consumed, and the stream a test scripts. */
export class FakeClaudeQuery implements ClaudeSdkQuery {
  readonly options: Options;
  /** Every user message the driver handed the SDK, in order — the prompt-resend assertions. */
  readonly received: SDKUserMessage[] = [];
  readonly modelCalls: (string | undefined)[] = [];
  readonly effortCalls: (EffortLevel | null | undefined)[] = [];
  interrupted = 0;
  closed = false;
  /** The placeholder CLI process the driver spawned through its hook, when enabled. */
  child: SpawnedProcess | undefined;
  readonly #messages: SDKMessage[] = [];
  readonly #sdk: FakeClaudeSdk;
  readonly #options: FakeClaudeQueryOptions;
  #wake: (() => void) | undefined;
  #ended = false;
  #failure: Error | undefined;
  #initSent = false;

  constructor(
    sdk: FakeClaudeSdk,
    options: Options,
    prompt: AsyncIterable<SDKUserMessage>,
    queryOptions: FakeClaudeQueryOptions,
  ) {
    this.#sdk = sdk;
    this.options = options;
    this.#options = queryOptions;
    if (queryOptions.spawnChild) this.#spawnPlaceholder();
    void this.#consume(prompt);
  }

  #spawnPlaceholder(): void {
    const spawn = this.options.spawnClaudeCodeProcess;
    if (spawn === undefined) throw new Error("the driver set no spawnClaudeCodeProcess hook");
    const { cwd } = this.options;
    this.child = spawn({
      command: process.execPath,
      args: [
        "-e",
        this.#options.stubbornChild
          ? "process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000)"
          : "process.stdin.resume()",
      ],
      ...(cwd === undefined ? {} : { cwd }),
      env: this.options.env ?? process.env,
      signal: new AbortController().signal,
    });
  }

  /** Reads the driver's prompt queue; each message runs the scripted turn. */
  async #consume(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
    try {
      for await (const message of prompt) {
        if (this.closed) return;
        this.received.push(message);
        this.#options.turn?.(this, textOf(message));
        if (this.#options.turn === undefined) this.#answerDefault(textOf(message));
      }
    } catch {
      // A stop ends the queue; the stream below is what the driver reads.
    }
  }

  #answerDefault(text: string): void {
    const id = `msg_${this.received.length}`;
    this.emit(assistantText(`${id}_answer`, `Echo: ${text}`));
    this.emit(resultSuccess());
  }

  /** Adds a scripted message to the stream the driver reads. */
  emit(message: SDKMessage): void {
    if (this.closed) throw new Error("the fake query is closed");
    this.#messages.push(message);
    this.#wake?.();
    this.#wake = undefined;
  }

  /** Ends the stream cleanly, as a stopped CLI does. */
  end(): void {
    this.#ended = true;
    this.#wake?.();
    this.#wake = undefined;
  }

  /** Ends the stream with an error, as a crashed CLI does. */
  fail(message: string): void {
    this.#failure = new Error(message);
    this.#wake?.();
    this.#wake = undefined;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child?.stdin?.end();
    this.end();
  }

  async interrupt(): Promise<unknown> {
    this.interrupted += 1;
    return undefined;
  }

  async setModel(model?: string): Promise<void> {
    this.modelCalls.push(model);
  }

  async applyFlagSettings(settings: { effortLevel?: EffortLevel | null }): Promise<void> {
    this.effortCalls.push(settings.effortLevel);
  }

  async supportedModels(): Promise<ModelInfo[]> {
    if (this.#options.modelsHang) return new Promise<ModelInfo[]>(() => {});
    if (this.#options.modelsFails !== undefined) throw new Error(this.#options.modelsFails);
    return this.#sdk.models;
  }

  /** Waits until the driver has handed the SDK `count` user messages. */
  async whenPrompted(count = 1, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.received.length < count) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} prompt(s)`);
      // oxlint-disable-next-line no-await-in-loop -- one poll per tick until the count arrives
      await new Promise((settle) => setTimeout(settle, 5));
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage, void> {
    if (!this.#options.silent && !this.#initSent) {
      this.#initSent = true;
      yield claudeInit();
    }
    while (true) {
      const message = this.#messages.shift();
      if (message !== undefined) {
        yield message;
        continue;
      }
      if (this.#failure !== undefined) throw this.#failure;
      if (this.#ended || this.closed) {
        if (this.#options.crash !== undefined) throw new Error(this.#options.crash);
        return;
      }
      // oxlint-disable-next-line no-await-in-loop -- one scripted message per iteration is the point
      await new Promise<void>((settle) => (this.#wake = settle));
    }
  }
}

/** The model list the probe measured on 2.1.316, with two effort shapes for the switch test. */
export const DEFAULT_MODELS: ModelInfo[] = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5",
    displayName: "Default (recommended)",
    description: "Opus 5.5 · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5-5",
    displayName: "Sonnet",
    description: "Sonnet 5.5 · Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high"],
  },
];

/**
 * A scripted frame fills only what the driver reads; the SDK's message union is a wire type and
 * requires fields a fake has no reason to invent.
 */
export function scriptedMessage(value: object): SDKMessage {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a scripted frame is partial
  return value as SDKMessage;
}

/** The same frame as a replayed one, as a resumed SDK query can redeliver a transcript. */
export function replayOf(message: SDKMessage): SDKMessage {
  return scriptedMessage(Object.assign({}, message, { isReplay: true }));
}

export function claudeInit(model = "claude-opus-5-5", effort: string | null = null): SDKMessage {
  return scriptedMessage({
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    claude_code_version: "2.1.316",
    cwd: "/tmp",
    tools: [],
    mcp_servers: [],
    model,
    permissionMode: "default",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    ...(effort === null ? {} : { effort }),
    uuid: "init-1",
    session_id: "session-1",
  });
}

function messageOf(id: string, content: unknown[], role: "assistant" | "user"): SDKMessage {
  return scriptedMessage({
    type: role,
    message: { id, role, content, model: "claude-opus-5-5", stop_reason: null, usage: {} },
    parent_tool_use_id: null,
    uuid: `${id}-uuid`,
    session_id: "session-1",
  });
}

export function assistantText(id: string, text: string): SDKMessage {
  return messageOf(id, [{ type: "text", text }], "assistant");
}

export function assistantThinking(id: string, thinking: string): SDKMessage {
  return messageOf(id, [{ type: "thinking", thinking, signature: "sig" }], "assistant");
}

export function assistantToolUse(
  id: string,
  toolUseID: string,
  name: string,
  input: Record<string, unknown>,
): SDKMessage {
  return messageOf(id, [{ type: "tool_use", id: toolUseID, name, input }], "assistant");
}

export function toolResult(
  toolUseID: string,
  output: string,
  options: { isError?: boolean; toolUseResult?: unknown } = {},
): SDKMessage {
  const message = messageOf(
    `result-${toolUseID}`,
    [
      {
        type: "tool_result",
        tool_use_id: toolUseID,
        content: output,
        ...(options.isError === true ? { is_error: true } : {}),
      },
    ],
    "user",
  );
  if (options.toolUseResult !== undefined) {
    return scriptedMessage({ ...message, tool_use_result: options.toolUseResult });
  }
  return message;
}

export function resultSuccess(text = ""): SDKMessage {
  return scriptedMessage({
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    result: text,
    errors: [],
    uuid: "result-uuid",
    session_id: "session-1",
  });
}

export function resultError(message: string): SDKMessage {
  return scriptedMessage({
    type: "result",
    subtype: "error_during_execution",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: 0,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    errors: [message],
    uuid: "result-uuid",
    session_id: "session-1",
  });
}

/** The raw stream events the CLI emits with `includePartialMessages`: one text block, chunked. */
export function streamText(messageId: string, chunks: readonly string[]): SDKMessage[] {
  const events: SDKMessage[] = [
    scriptedMessage({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { id: messageId, role: "assistant", content: [] },
      },
      parent_tool_use_id: null,
      uuid: `${messageId}-start`,
      session_id: "session-1",
    }),
    scriptedMessage({
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      parent_tool_use_id: null,
      uuid: `${messageId}-block`,
      session_id: "session-1",
    }),
  ];
  for (const [index, chunk] of chunks.entries()) {
    events.push(
      scriptedMessage({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: chunk },
        },
        parent_tool_use_id: null,
        uuid: `${messageId}-delta-${index}`,
        session_id: "session-1",
      }),
    );
  }
  events.push(
    scriptedMessage({
      type: "stream_event",
      event: { type: "content_block_stop", index: 0 },
      parent_tool_use_id: null,
      uuid: `${messageId}-stop`,
      session_id: "session-1",
    }),
  );
  return events;
}

/** One transcript message, as `getSessionMessages` returns it. */
export function sessionMessage(
  type: "user" | "assistant",
  uuid: string,
  content: unknown,
): SessionMessage {
  return scriptedSessionMessage({
    type,
    uuid,
    session_id: "session-1",
    message: { role: type, content },
    parent_tool_use_id: null,
    parent_agent_id: null,
  });
}

function scriptedSessionMessage(value: object): SessionMessage {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a transcript entry is partial
  return value as SessionMessage;
}

function textOf(message: SDKUserMessage): string {
  const content = message.message.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}
