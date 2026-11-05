import {
  CAPABILITY_REFUSED_CLOSE_CODE,
  PROTOCOL_MISMATCH_CLOSE_CODE,
  ProtocolMismatchReason,
} from "@corral/protocol/handshake";
import type { ConnectionState } from "./connection-state.ts";

export interface Backoff {
  initialMs: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: Backoff = { initialMs: 250, maxMs: 5000 };

/** Delay before retry number `failures` (1 for the first retry): doubles from `initialMs` up to `maxMs`. */
export function reconnectDelayMs(failures: number, backoff: Backoff): number {
  return Math.min(backoff.maxMs, backoff.initialMs * 2 ** Math.max(0, failures - 1));
}

export type CreateSocket = (url: string, protocols: string[]) => WebSocket;

export interface SocketEndpoint {
  url: string;
  protocols: string[];
}

export interface ReconnectingSocketOptions {
  url: string;
  /** Sent on every attempt, including reconnects, so a capability never needs re-provisioning. */
  protocols: string[];
  /**
   * Asked before every attempt when the server may have restarted with a new capability.
   * `undefined` means the endpoint is not available yet; the socket retries with backoff.
   */
  refreshEndpoint?: (() => Promise<SocketEndpoint | undefined>) | undefined;
  backoff?: Backoff | undefined;
  createSocket?: CreateSocket | undefined;
  onState(state: ConnectionState): void;
  /** Every time a socket opens; attach message listeners here. */
  onOpen(socket: WebSocket): void;
  /**
   * Every time a socket closes; say whether a transient drop should try again. A protocol
   * mismatch or refused capability also reports here so the caller can clear its socket; the
   * return value is ignored for those terminal states.
   */
  onClose(event: CloseEvent): "retry" | "stop";
}

/** One logical connection to a URL: reopens the socket with backoff until stopped or refused. */
export class ReconnectingSocket {
  readonly #options: ReconnectingSocketOptions;
  readonly #backoff: Backoff;
  #socket: WebSocket | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #failures = 0;
  #attempts = 0;
  #startedAt = Date.now();
  #stopped = false;
  #refreshing = false;

  constructor(options: ReconnectingSocketOptions) {
    this.#options = options;
    this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.#connect();
  }

  close(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#socket?.close();
    this.#socket = undefined;
  }

  /** Retry now instead of waiting for the backoff; a no-op while one is already in flight. */
  retry(): void {
    if (this.#stopped || this.#socket !== undefined || this.#refreshing) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#connect();
  }

  #connect(): void {
    if (this.#stopped || this.#refreshing) return;
    this.#attempts += 1;
    this.#options.onState({
      status: "connecting",
      attempt: this.#attempts,
      startedAt: this.#startedAt,
    });
    const refresh = this.#options.refreshEndpoint;
    if (!refresh) {
      this.#open(this.#options.url, this.#options.protocols);
      return;
    }
    this.#refreshing = true;
    void refresh().then(
      (endpoint) => {
        this.#refreshing = false;
        if (this.#stopped) return;
        this.#open(
          endpoint?.url ?? this.#options.url,
          endpoint?.protocols ?? this.#options.protocols,
        );
      },
      () => {
        this.#refreshing = false;
        if (!this.#stopped) this.#scheduleRetry();
      },
    );
  }

  #open(url: string, protocols: string[]): void {
    let socket: WebSocket;
    try {
      socket = this.#options.createSocket?.(url, protocols) ?? new WebSocket(url, protocols);
    } catch (error) {
      // A capability that is not a valid subprotocol token throws here, before any socket exists.
      // Retrying the same target cannot help; a new capability can, so `retry()` stays available.
      this.#options.onState({
        status: "invalid-capability",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    socket.addEventListener("open", () => {
      if (this.#socket !== socket) return;
      this.#failures = 0;
      this.#attempts = 1;
      this.#startedAt = Date.now();
      // Opened first: whoever reacts to "connected" expects the socket to be wired up.
      this.#options.onOpen(socket);
      this.#options.onState({ status: "connected" });
    });
    socket.addEventListener("close", (event) => this.#onClose(socket, event));
  }

  #onClose(socket: WebSocket, event: CloseEvent): void {
    if (this.#socket !== socket) return;
    this.#socket = undefined;
    if (event.code === PROTOCOL_MISMATCH_CLOSE_CODE) {
      this.#options.onClose(event);
      this.#options.onState({
        status: "protocol-mismatch",
        serverProtocolVersion: parseServerVersion(event.reason),
      });
      return;
    }
    if (event.code === CAPABILITY_REFUSED_CLOSE_CODE) {
      this.#options.onClose(event);
      this.#options.onState({
        status: "capability-refused",
        attempt: this.#attempts,
        startedAt: this.#startedAt,
      });
      return;
    }
    if (this.#options.onClose(event) === "stop") return;
    this.#scheduleRetry();
  }

  #scheduleRetry(): void {
    // Elapsed time is how long this trouble has lasted, not how long the last connection did.
    if (this.#failures === 0) this.#startedAt = Date.now();
    this.#options.onState({
      status: "disconnected",
      attempt: this.#attempts,
      startedAt: this.#startedAt,
    });
    this.#failures += 1;
    this.#timer = setTimeout(
      () => this.#connect(),
      reconnectDelayMs(this.#failures, this.#backoff),
    );
  }
}

function parseServerVersion(reason: string): number | undefined {
  try {
    const parsed = ProtocolMismatchReason.safeParse(JSON.parse(reason));
    return parsed.success ? parsed.data.serverProtocolVersion : undefined;
  } catch {
    return undefined;
  }
}
