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
  /**
   * The instance's own argv, already accepted by its runtime's policy. It stands before every
   * Corral- or driver-owned flag, the same order native model discovery uses; a driver with no
   * seam for extra flags never reaches here because the session launch refuses the instance.
   */
  instanceArgs?: readonly string[];
  /** The native model and provider a profile or the user chose; `null` where neither is set. */
  model: string | null;
  provider: string | null;
  /** The agent's own conversation id; `null` when this session has none yet. */
  agentSessionId: string | null;
  /** A new conversation under the id, or the recorded one resumed. */
  how: "start" | "resume";
  /** A candidate first prompt; only a launch that finds no conversation hands it over. */
  prompt: string | null;
  /**
   * A server this launch's own frontends attach to, when the agent keeps the session in one (C1's
   * `opencode serve`). The session service starts it and passes its address; a driver whose agent
   * has no such server gets none and must not start one (`design.md`, **Terminal and chat**).
   */
  server?: { url: string; password: string };
  /**
   * A unix socket of an agent server this launch's frontends attach to (C3's Codex app-server).
   * It is the same process the session's terminal leg attaches to, which is what makes the two
   * views live at once; the session service starts it and the terminal leg gets the same path.
   */
  socket?: string;
  /**
   * Whether a terminal frontend of this session is live beside the chat frontend. A request the
   * chat driver does not render (a permissions profile, an elicitation) can be left to that
   * terminal only when there is one; a chat-only session must refuse it visibly instead of leaving
   * the agent waiting for an answer nobody will give. A function is asked at the moment of the
   * request: a terminal that `/quit`ed after the chat launch is gone, not live.
   */
  terminalLive?: boolean | (() => boolean);
  /**
   * The agent assigned the conversation id (Codex's thread id); the session service stores it in
   * `Session.agentSessionId`. Agents that accept a caller-chosen id never call this.
   */
  onAgentSessionId?(agentSessionId: string): void;
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
 * The persisted writer record of one launch: which process holds this session's agent
 * conversation, so a server that starts again stops it before spawning its own. The service owns
 * it — the path, the pid's identity (`writer-claim.ts`) and the rule that a refused launch keeps
 * the record — and hands the driver this pair; the driver only knows which process it started.
 *
 * - `record(pid)` after the process exists, and again if a driver replaces it (a restarted child).
 * - `release()` when that process is gone; a process that outlived the driver keeps its record, so
 *   the next launch refuses rather than spawning beside it.
 *
 * **A process shared by several sessions is not recorded here.** C1's `opencode serve` holds many
 * sessions' conversations; one per-session record per attached session would let the next launch
 * of session A kill the process session B is using, and the first stop would forget it while it
 * still runs. A shared writer is recorded **once, keyed by the process rather than a session**, at
 * `<dataDir>/chat/opencode-server.json` (`opencode-server.ts`), and released when the last session
 * using it stops. The OpenCode chat driver therefore reports no process through this pair: its
 * conversation is the shared server's, and the pool's process record is the one-writer record.
 * Its terminal leg is a client of the same pool record; the session's two legs are one writer
 * because the server is the conversation, not because of a per-session pid.
 *
 * C3's Codex app-server is one process per session, so its record is per session too:
 * `<dataDir>/chat/codex-server-<session>.json`, written and released by `codex-server.ts` (the
 * pool), again through this module. The Codex driver is a client and reports nothing here.
 */
export interface ChatWriterClaim {
  record(pid: number): void;
  release(): void;
}

/**
 * A launch with its argv built and the service's own bookkeeping resolved. The timeline and the
 * writer claim are the service's: the driver gets the timeline it must stream into (its start is
 * the reserved sequence floor) and the record pair it reports its process through. It decides
 * neither.
 */
export interface ChatDriverLaunch {
  sessionId: string;
  /**
   * The chat timeline every event of this frontend goes through. The service built it from the
   * reserved sequence floor, so a cursor held from a replaced frontend is a hole and gets a
   * snapshot; a driver must stream into this instance, never its own.
   */
  timeline: ChatTimeline;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /**
   * The native model a profile or the user chose — the same fact `args(facts)` receives, for a
   * driver whose frontend is constructed (Claude's SDK `Options.model`) instead of spawned.
   */
  model: string | null;
  /** The conversation this frontend opens, new or resumed (`Options.sessionId`/`resume`). */
  how: "start" | "resume";
  prompt: string | null;
  /**
   * The agent's own conversation id this frontend opens, after the driver's argv was built from it
   * (`ChatLaunchFacts`). A client of an agent server addresses the same id a terminal does.
   */
  agentSessionId: string | null;
  /** The shared server this frontend is a client of, when its agent has one; see `ChatLaunchRequest`. */
  server?: { url: string; password: string };
  /** The unix socket of the agent server this frontend is a client of; see `ChatLaunchRequest`. */
  socket?: string;
  /**
   * The provider the launch chose, the same value the terminal's own flags carry. A driver whose
   * agent takes it on the conversation (Codex's `thread/start`) sends it there.
   */
  provider?: string | null;
  /** Whether a terminal leg is live beside this frontend; see `ChatLaunchRequest.terminalLive`. */
  terminalLive?: boolean | (() => boolean);
  /** Reports the conversation id the agent assigned, once; see `ChatLaunchRequest`. */
  onAgentSessionId?(agentSessionId: string): void;
  /** The record of the process holding this session's conversation; see `ChatWriterClaim`. */
  writer: ChatWriterClaim;
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
 * - it streams into the `timeline` it was handed, whose start is the reserved sequence floor; the
 *   service refuses a driver whose `timeline` is not the one it passed, so a driver cannot put a
 *   stale cursor back on top of a rebuilt conversation;
 * - it reports its process through the launch's `writer` pair and never writes the record's path or
 *   identity itself; a process it shares with other sessions is not this pair's business (see
 *   `ChatWriterClaim`: shared writers are recorded once, keyed by the process, and C1 adds that);
 * - it never invents a client-visible code: a refusal is one of the agent-neutral classes in
 *   `chat-errors.ts` (`ChatUnavailableError`, `ChatModelUnsupportedError`,
 *   `ChatReasoningUnsupportedError`, `ChatRequestUnknownError`) and the RPC layer maps it; a
 *   driver's own text never becomes a code, and a driver-specific failure is an `error` item or an
 *   exit reason.
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
  /**
   * Starts the frontend. A failure is `onExit` with a reason, not a throw: a driver that throws
   * anyway is treated as one that exited (`ChatService` reports the reason and frees the id).
   */
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
