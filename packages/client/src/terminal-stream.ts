import { capabilityProtocols, protocolUrl } from "@corral/protocol/handshake";
import type { ServerTarget } from "@corral/protocol/server-target";
import type { TerminalExit, TerminalSize } from "@corral/protocol/rpc";
import {
  ServerTerminalMessage,
  TERMINAL_NOT_FOUND_CLOSE_CODE,
  terminalStreamPath,
  type ClientTerminalMessage,
} from "@corral/protocol/terminal-stream";
import type { ConnectionState } from "./connection-state.ts";
import { ReconnectingSocket, type Backoff, type CreateSocket } from "./reconnecting-socket.ts";
import { Store, type ReadableStore } from "./store.ts";

/** The part of xterm.js (and @xterm/headless) the stream writes into. */
export interface TerminalSurface {
  /** `callback` runs once the terminal has parsed `data`, in write order. */
  write(data: string | Uint8Array, callback?: () => void): void;
  reset(): void;
  resize(cols: number, rows: number): void;
}

export type TerminalStreamState =
  | ConnectionState
  /** The process ended; the screen stays. The stream does not reconnect. */
  | { status: "exited"; exit: TerminalExit }
  /** The server has no such terminal (closed, or never existed). */
  | { status: "not-found" };

export interface TerminalStreamOptions {
  server: ServerTarget;
  /** Re-read before each attempt; a restarted server has a new capability. */
  refreshServer?: (() => Promise<ServerTarget | undefined>) | undefined;
  terminalId: string;
  surface: TerminalSurface;
  backoff?: Backoff;
  createSocket?: CreateSocket;
}

/**
 * Keeps `surface` showing one server terminal: replays the snapshot and output into it, acks
 * output once the surface has parsed it, and re-attaches (getting a fresh snapshot) after a
 * dropped connection.
 */
export class TerminalStream {
  readonly #state = new Store<TerminalStreamState>({ status: "connecting" });
  readonly #surface: TerminalSurface;
  readonly #connection: ReconnectingSocket;
  /** The open socket; input is accepted from here on, the server orders it after the snapshot. */
  #open: WebSocket | undefined;
  /**
   * Input typed before the first connection opens, e.g. right after creating a terminal. It is
   * sent on open; if that first attempt fails it is dropped, as typing is never replayed later.
   */
  #earlyInput: Uint8Array<ArrayBuffer>[] | undefined = [];
  /** Set once the current socket has delivered its first snapshot. */
  #attached: WebSocket | undefined;
  #desiredSize: TerminalSize | undefined;
  #lastSentSize: TerminalSize | undefined;
  #serverSize: TerminalSize | undefined;

  constructor(options: TerminalStreamOptions) {
    this.#surface = options.surface;
    const refreshServer = options.refreshServer;
    this.#connection = new ReconnectingSocket({
      url: protocolUrl(options.server.url, terminalStreamPath(options.terminalId)),
      protocols: capabilityProtocols(options.server.capability),
      ...(refreshServer === undefined
        ? {}
        : {
            refreshEndpoint: async () => {
              const target = await refreshServer();
              return target === undefined
                ? undefined
                : {
                    url: protocolUrl(target.url, terminalStreamPath(options.terminalId)),
                    protocols: capabilityProtocols(target.capability),
                  };
            },
          }),
      backoff: options.backoff,
      createSocket: options.createSocket,
      onState: (state) => this.#state.set(state),
      onOpen: (socket) => {
        this.#open = socket;
        for (const data of this.#earlyInput ?? []) socket.send(data);
        this.#earlyInput = undefined;
        socket.addEventListener("message", (event) => this.#onMessage(socket, event));
      },
      onClose: (event) => this.#onClose(event),
    });
  }

  get state(): ReadableStore<TerminalStreamState> {
    return this.#state;
  }

  /** Keyboard input. Dropped while not connected (after the first attempt): replaying old typing would surprise. */
  input(data: string | Uint8Array<ArrayBuffer>): void {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (this.#open) this.#open.send(bytes);
    else this.#earlyInput?.push(bytes);
  }

  /** Asks for this size, now or as soon as the terminal is attached; the latest request wins. */
  resize(size: TerminalSize): void {
    this.#desiredSize = size;
    this.#sendDesiredSize();
  }

  close(): void {
    this.#connection.close();
    this.#open = undefined;
    this.#earlyInput = undefined;
    this.#attached = undefined;
  }

  #onClose(event: CloseEvent): "retry" | "stop" {
    this.#open = undefined;
    this.#earlyInput = undefined;
    this.#attached = undefined;
    this.#lastSentSize = undefined;
    if (event.code === TERMINAL_NOT_FOUND_CLOSE_CODE) {
      this.#state.set({ status: "not-found" });
      return "stop";
    }
    return this.#state.getSnapshot().status === "exited" ? "stop" : "retry";
  }

  #onMessage(socket: WebSocket, event: MessageEvent): void {
    if (typeof event.data === "string") {
      const message = parseServerMessage(event.data);
      if (message) this.#onControl(socket, message);
      else socket.close(1008, "invalid message");
    } else if (event.data instanceof ArrayBuffer) {
      this.#onOutput(socket, new Uint8Array(event.data));
    }
  }

  #onControl(socket: WebSocket, message: ServerTerminalMessage): void {
    switch (message.type) {
      case "snapshot": {
        const { size, data } = message;
        this.#serverSize = size;
        this.#lastSentSize = undefined;
        // In write order, so output still queued is parsed before the screen is replaced.
        this.#surface.write("", () => {
          this.#surface.reset();
          this.#surface.resize(size.cols, size.rows);
        });
        this.#surface.write(data);
        if (this.#attached !== socket) {
          this.#attached = socket;
          this.#sendDesiredSize();
        }
        break;
      }
      case "resized":
        this.#serverSize = message.size;
        this.#lastSentSize = undefined;
        this.#surface.write("", () => this.#surface.resize(message.size.cols, message.size.rows));
        break;
      case "exit":
        this.#state.set({ status: "exited", exit: message.exit });
        break;
    }
  }

  #onOutput(socket: WebSocket, bytes: Uint8Array): void {
    this.#surface.write(bytes, () => {
      if (this.#attached === socket && socket.readyState === WebSocket.OPEN) {
        send(socket, { type: "ack", bytes: bytes.length });
      }
    });
  }

  #sendDesiredSize(): void {
    const socket = this.#attached;
    const size = this.#desiredSize;
    if (!socket || !size || socket.readyState !== WebSocket.OPEN) return;
    const known = this.#lastSentSize ?? this.#serverSize;
    if (known && known.cols === size.cols && known.rows === size.rows) return;
    this.#lastSentSize = size;
    send(socket, { type: "resize", size });
  }
}

function send(socket: WebSocket, message: ClientTerminalMessage): void {
  socket.send(JSON.stringify(message));
}

function parseServerMessage(text: string): ServerTerminalMessage | undefined {
  try {
    const parsed = ServerTerminalMessage.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
