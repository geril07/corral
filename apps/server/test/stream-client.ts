import { protocolUrl } from "@corral/protocol/handshake";
import type { TerminalSize } from "@corral/protocol/rpc";
import {
  ServerTerminalMessage,
  terminalStreamPath,
  type ClientTerminalMessage,
} from "@corral/protocol/terminal-stream";
import type { Terminal } from "@xterm/headless";
import { WebSocket } from "ws";
import { createClientTerminal, screenLines, writeAndWait } from "./client-terminal.ts";

const DEFAULT_DEADLINE_MS = 15_000;

export interface Closed {
  code: number;
  reason: string;
}

/**
 * A terminal client as the desktop app will be: it replays snapshots and output into its own
 * terminal and acks output once that terminal has parsed it. `ack: false` makes it a client
 * that never acks.
 */
export class StreamClient {
  readonly messages: ServerTerminalMessage[] = [];
  readonly outputChunks: Buffer[] = [];
  readonly terminal: Terminal;
  closed: Closed | undefined;
  outputBytes = 0;
  /** Acks each output chunk once it is parsed; chunks before `ackAll` were acked by it. */
  autoAck: boolean;
  readonly #socket: WebSocket;
  #ackedChunks = 0;
  readonly #watchers = new Set<() => void>();

  private constructor(socket: WebSocket, autoAck: boolean) {
    this.#socket = socket;
    this.autoAck = autoAck;
    this.terminal = createClientTerminal({ cols: 80, rows: 24 });
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) this.#onOutput(data);
      else this.#onMessage(ServerTerminalMessage.parse(JSON.parse(data.toString("utf8"))));
    });
    // Closed only once the terminal has parsed everything received before the close.
    socket.on("close", (code, reason) => {
      this.terminal.write("", () => {
        this.closed = { code, reason: reason.toString("utf8") };
        this.#changed();
      });
    });
  }

  /** Resolves once the socket is open; a refused upgrade or a close before open rejects. */
  static async connect(
    serverUrl: string,
    terminalId: string,
    options: { ack?: boolean; url?: string } = {},
  ): Promise<StreamClient> {
    const url = options.url ?? protocolUrl(serverUrl, terminalStreamPath(terminalId));
    const socket = new WebSocket(url);
    const client = new StreamClient(socket, options.ack ?? true);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return client;
  }

  get snapshots(): Extract<ServerTerminalMessage, { type: "snapshot" }>[] {
    return this.messages.filter((message) => message.type === "snapshot");
  }

  get screen(): string[] {
    return screenLines(this.terminal);
  }

  get rawOutput(): string {
    return Buffer.concat(this.outputChunks).toString("utf8");
  }

  send(message: ClientTerminalMessage): void {
    this.#socket.send(JSON.stringify(message));
  }

  type(text: string): void {
    this.#socket.send(Buffer.from(text), { binary: true });
  }

  resize(size: TerminalSize): void {
    this.send({ type: "resize", size });
  }

  /** Acks everything received so far, then acks the rest chunk by chunk. */
  ackAll(): void {
    const pending = this.outputChunks.slice(this.#ackedChunks);
    this.#ackedChunks = this.outputChunks.length;
    const bytes = pending.reduce((sum, chunk) => sum + chunk.length, 0);
    if (bytes > 0) this.send({ type: "ack", bytes });
    this.autoAck = true;
  }

  /** Waits until `condition` holds, re-checking after every message, parsed write and close. */
  waitFor(
    condition: () => boolean,
    description: string,
    deadlineMs = DEFAULT_DEADLINE_MS,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const check = () => {
        if (!condition()) return;
        cleanup();
        resolve();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `timed out waiting for ${description}; closed=${JSON.stringify(this.closed)} screen tail:\n${this.screen.slice(-12).join("\n")}`,
          ),
        );
      }, deadlineMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.#watchers.delete(check);
      };
      this.#watchers.add(check);
      check();
    });
  }

  waitForScreen(text: string): Promise<void> {
    return this.waitFor(
      () => this.screen.some((line) => line.includes(text)),
      `"${text}" on screen`,
    );
  }

  async waitForClose(): Promise<Closed> {
    await this.waitFor(() => this.closed !== undefined, "the socket to close");
    return this.closed!;
  }

  close(): void {
    this.#socket.terminate();
  }

  #changed(): void {
    for (const watcher of this.#watchers) watcher();
  }

  #onOutput(data: Buffer): void {
    const sequence = this.outputChunks.push(data) - 1;
    this.outputBytes += data.length;
    this.terminal.write(data, () => {
      if (
        this.autoAck &&
        sequence >= this.#ackedChunks &&
        this.#socket.readyState === WebSocket.OPEN
      )
        this.send({ type: "ack", bytes: data.length });
      this.#changed();
    });
    this.#changed();
  }

  #onMessage(message: ServerTerminalMessage): void {
    this.messages.push(message);
    if (message.type === "snapshot") {
      this.terminal.write("", () => {
        this.terminal.reset();
        this.terminal.resize(message.size.cols, message.size.rows);
      });
      void writeAndWait(this.terminal, message.data).then(() => this.#changed());
    } else if (message.type === "resized") {
      this.terminal.write("", () => {
        this.terminal.resize(message.size.cols, message.size.rows);
        this.#changed();
      });
    }
    this.#changed();
  }
}
