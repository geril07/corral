import type {
  ChatAnswer,
  ChatDriverCapabilities,
  ChatModelRef,
  ChatSessionState,
} from "@corral/protocol/chat";
import type { AgentKind, AgentStatus, ChatSendMode } from "@corral/protocol/rpc";
import type { ChatTimeline } from "./timeline.ts";

/**
 * What a driver declares about itself, as `chat.capabilities` reports it (`ChatDriverCapabilities`
 * adds the kind). It is data, not a question to the agent at runtime: the UI enables or disables a
 * control from it instead of offering one whose call would be refused. A driver that cannot steer,
 * for example, sets `steer: false` and the composer hides the mode.
 */
export type ChatDriverDeclaration = Omit<ChatDriverCapabilities, "kind">;

/**
 * The deadlines the service shares with every driver. They bound supervision, not a provider
 * protocol: a dialog the server stops waiting for, a start-up that has to answer, and the grace a
 * child gets after a stop before its process group is killed. Tests shorten them; production runs
 * the defaults `ChatService` owns.
 */
export interface ChatTimeouts {
  /** A user request the server stops waiting for; the agent's own timeout may be shorter. */
  dialogTimeoutMs: number;
  /** How long a driver gets to report its session state before the frontend is failed. */
  readyTimeoutMs: number;
  /** How long the child gets to exit after a stop request before its group is killed. */
  exitGraceMs: number;
}

/**
 * What the service resolves before any driver exists: everything a launch knows that is not the
 * agent's own argv. A driver never sees the session row, the profile or the task.
 */
export interface ChatLaunchRequest {
  sessionId: string;
  /** Which registered driver runs this session; the registry refuses a kind without one. */
  kind: AgentKind;
  /** The agent executable to run, already resolved from `[agents.<kind>].command` or `PATH`. */
  command: string;
  cwd: string;
  /** The launch environment, exactly as a terminal launch of this session would get it. */
  env: Record<string, string>;
  /** The native model and provider a profile or the user chose; `null` where neither is set. */
  model: string | null;
  provider: string | null;
  /** The agent's own conversation id; `null` when this session has none yet. */
  agentSessionId: string | null;
  /** A new conversation under the id, or the recorded one resumed. */
  how: "start" | "resume";
  /** A candidate first prompt; only a launch that finds no conversation hands it over. */
  prompt: string | null;
  onStatus(status: AgentStatus): void;
  /** The frontend is gone; `reason` is null for a stop the server asked for. */
  onExit(reason: string | null): void;
}

/**
 * The part of a launch request a driver turns into its agent's chat argv. The chat argv is the
 * driver's, not the registry's and not the session service's: only an agent's own frontend knows
 * which flags open it, so adding a driver adds no branch outside that driver.
 */
export type ChatLaunchFacts = Pick<
  ChatLaunchRequest,
  "model" | "provider" | "agentSessionId" | "how"
>;

/**
 * A launch with its argv built and the service's own bookkeeping resolved. `claimPath` and
 * `startAt` are the service's (the writer record and the sequence floor); a driver writes through
 * them and never decides either.
 */
export interface ChatDriverLaunch {
  sessionId: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  prompt: string | null;
  /** Where this process's pid is recorded, so a later server can stop it before spawning. */
  claimPath: string;
  /** The sequence this frontend's timeline starts at; above a predecessor it replaces. */
  startAt: number;
  onStatus(status: AgentStatus): void;
  onExit(reason: string | null): void;
}

/** Everything a driver is built with: the resolved launch and the service's deadlines. */
export interface ChatDriverStart extends ChatDriverLaunch, ChatTimeouts {}

/**
 * One live chat frontend, whatever the agent behind it. `ChatService` owns the session id, the
 * writer record and the sequence floor around it, and decides every client-visible refusal; a
 * driver owns the child (or the socket), the conversation and the projection into the timeline.
 *
 * Rules a driver inherits rather than re-implements:
 * - it never starts a second frontend on one session id (the service refuses the launch first);
 * - it never writes the sequence floor or the writer record's identity (it calls the shared
 *   `writer-claim`/`sequence-floor` functions with the paths the service hands it);
 * - it never invents a client-visible code: refusals are `ChatUnavailableError`, `ChatModelUnsupportedError`,
 *   `ChatReasoningUnsupportedError` and `ChatRequestUnknownError` from `chat-errors.ts`, which the
 *   RPC layer maps, and a driver-specific failure is an `error` item or an exit reason, not a code.
 */
export interface ChatDriver {
  /** The session this frontend serves; the service's map key and the timeline's owner. */
  readonly sessionId: string;
  /** The chat timeline every event goes through: Corral's, one copy, shared by all drivers. */
  readonly timeline: ChatTimeline;
  /** The session state the chat contract reports. */
  readonly state: ChatSessionState;
  /** True once the frontend is gone and will not report again. */
  readonly closed: boolean;
  /** Starts the frontend. Never throws for a spawn: a failure is `onExit` with a reason. */
  start(): void;
  /** Stops it and resolves once it is gone. Called again after a stop, it just awaits. */
  stop(): Promise<void>;
  /** Sends a message and returns the id of the item it became. */
  send(text: string, mode: ChatSendMode): string;
  abort(): Promise<void>;
  respond(itemId: string, value: ChatAnswer): void;
  setModel(model: ChatModelRef): Promise<void>;
  setReasoning(level: string): Promise<void>;
}

/** One driver this build ships: what it declares, its chat argv, and how it builds a frontend. */
export interface ChatDriverRegistration {
  readonly capabilities: ChatDriverDeclaration;
  /** The argument list of a chat launch, from the agent's own CLI. */
  args(facts: ChatLaunchFacts): string[];
  create(launch: ChatDriverStart): ChatDriver;
}

/** The drivers of one build or one `ChatService`, by agent kind. A kind without an entry has none. */
export type ChatDriverRegistry = Partial<Record<AgentKind, ChatDriverRegistration>>;
