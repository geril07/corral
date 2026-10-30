import type { TerminalExit, TerminalInfo, TerminalSize } from "@corral/protocol/rpc";
import { spawn, type IPty } from "node-pty";
import { HeadlessTerminal } from "./headless-terminal.ts";
import { OutputCredit } from "./output-credit.ts";
import { PendingInputTail } from "./pending-input-tail.ts";

/** Unprocessed bytes queued in the headless terminal before the PTY is paused, and where it resumes. */
export interface BacklogLimits {
  pauseBytes: number;
  resumeBytes: number;
}
const DEFAULT_BACKLOG_LIMITS: BacklogLimits = { pauseBytes: 1024 * 1024, resumeBytes: 256 * 1024 };

/** How long a PTY gets to exit after SIGHUP before it is killed outright. */
const KILL_GRACE_MS = 2000;

export interface TerminalSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  size: TerminalSize;
}

/** Where one attached client's messages go. All calls are synchronous and ordered. */
export interface StreamSink {
  snapshot(size: TerminalSize, data: string): void;
  output(bytes: Uint8Array): void;
  resized(size: TerminalSize): void;
  /** Last message; the process exited. */
  exit(exit: TerminalExit): void;
  /** The terminal was closed while attached. */
  terminalClosed(): void;
}

export interface TerminalAttachment {
  input(bytes: Uint8Array): void;
  resize(size: TerminalSize): void;
  ack(bytes: number): void;
  detach(): void;
}

/**
 * One PTY, the headless terminal that mirrors it, and the clients attached to it.
 *
 * PTY output goes into the headless terminal first and reaches clients only after the
 * terminal has parsed it. A snapshot is the terminal's state at that moment, so a client that
 * attaches (or resyncs) between two chunks gets a state that ends exactly where its live bytes
 * begin, with no gap and no overlap.
 */
export class TerminalSession {
  readonly id: string;
  readonly #pty: IPty;
  readonly #headless: HeadlessTerminal;
  readonly #attachments = new Set<ClientAttachment>();
  readonly #tail = new PendingInputTail();
  readonly #onChange: () => void;
  readonly #spec: TerminalSpec;
  readonly #backlogLimits: BacklogLimits;
  #size: TerminalSize;
  #exit: TerminalExit | null = null;
  #processExited = false;
  #closed = false;
  #backlogBytes = 0;
  #peakBacklogBytes = 0;
  #ptyPaused = false;
  #killTimer: NodeJS.Timeout | undefined;
  readonly #exited: Promise<void>;

  constructor(
    id: string,
    spec: TerminalSpec,
    onChange: () => void,
    backlogLimits: BacklogLimits = DEFAULT_BACKLOG_LIMITS,
  ) {
    this.id = id;
    this.#backlogLimits = backlogLimits;
    this.#spec = spec;
    this.#size = spec.size;
    this.#onChange = onChange;
    this.#headless = new HeadlessTerminal(spec.size);
    this.#pty = spawn(spec.command, spec.args, {
      name: "xterm-256color",
      cols: spec.size.cols,
      rows: spec.size.rows,
      cwd: spec.cwd,
      env: spec.env,
      encoding: null,
    });
    this.#exited = new Promise((resolve) => {
      this.#pty.onExit(({ exitCode, signal }) => {
        this.#processExited = true;
        clearTimeout(this.#killTimer);
        resolve();
        if (!this.#closed) this.#ordered(() => this.#recordExit(exitCode, signal));
      });
    });
    // `encoding: null` makes node-pty emit Buffers although its types say string.
    this.#pty.onData((chunk) => this.#receive(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  }

  get info(): TerminalInfo {
    return {
      id: this.id,
      command: this.#spec.command,
      args: this.#spec.args,
      cwd: this.#spec.cwd,
      size: this.#size,
      exit: this.#exit,
    };
  }

  /** Most bytes ever queued in the headless terminal at once; stays near the pause level under a flood. */
  get peakBacklogBytes(): number {
    return this.#peakBacklogBytes;
  }

  /** The snapshot is the first thing the sink receives. */
  attach(sink: StreamSink): TerminalAttachment {
    const attachment = new ClientAttachment(this, sink);
    this.#attachments.add(attachment);
    attachment.sendSnapshot();
    if (this.#exit) sink.exit(this.#exit);
    return attachment;
  }

  /** Kills the process and tells attached clients; resolves once the process is gone. */
  close(): Promise<void> {
    if (this.#closed) return this.#exited;
    this.#closed = true;
    for (const attachment of this.#attachments) attachment.sink.terminalClosed();
    this.#attachments.clear();
    this.#headless.dispose();
    if (!this.#processExited) {
      // A paused PTY never sees its socket close, so the exit would never be reported.
      this.#pty.resume();
      this.#signal("SIGHUP");
      this.#killTimer = setTimeout(() => this.#signal("SIGKILL"), KILL_GRACE_MS);
      this.#killTimer.unref();
    }
    return this.#exited;
  }

  /** Runs `action` after everything written to the headless terminal so far has been parsed. */
  #ordered(action: () => void): void {
    this.#headless.write("", () => {
      if (!this.#closed) action();
    });
  }

  #signal(signal: NodeJS.Signals): void {
    try {
      process.kill(this.#pty.pid, signal);
    } catch {
      // Already gone.
    }
  }

  #receive(chunk: Uint8Array): void {
    if (this.#closed) return;
    this.#backlogBytes += chunk.length;
    this.#peakBacklogBytes = Math.max(this.#peakBacklogBytes, this.#backlogBytes);
    if (!this.#ptyPaused && this.#backlogBytes > this.#backlogLimits.pauseBytes) {
      this.#ptyPaused = true;
      this.#pty.pause();
    }
    this.#headless.write(chunk, () => {
      this.#backlogBytes -= chunk.length;
      if (this.#ptyPaused && this.#backlogBytes <= this.#backlogLimits.resumeBytes) {
        this.#ptyPaused = false;
        if (!this.#closed) this.#pty.resume();
      }
      if (this.#closed) return;
      this.#tail.push(chunk);
      for (const attachment of this.#attachments) attachment.deliver(chunk);
    });
  }

  #recordExit(exitCode: number, signal: number | undefined): void {
    this.#exit = { exitCode, ...(signal ? { signal } : {}) };
    for (const attachment of this.#attachments) attachment.exit(this.#exit);
    this.#onChange();
  }

  resize(size: TerminalSize): void {
    if (this.#exit || this.#processExited) return;
    if (size.cols === this.#size.cols && size.rows === this.#size.rows) return;
    this.#size = size;
    this.#pty.resize(size.cols, size.rows);
    // The headless terminal resizes at this point of the stream, after output the old size produced.
    this.#ordered(() => {
      this.#headless.resize(size);
      for (const attachment of this.#attachments) attachment.sink.resized(size);
    });
    this.#onChange();
  }

  write(bytes: Uint8Array): void {
    if (!this.#exit && !this.#processExited) this.#pty.write(Buffer.from(bytes));
  }

  detach(attachment: ClientAttachment): void {
    this.#attachments.delete(attachment);
  }

  snapshotFor(attachment: ClientAttachment): void {
    attachment.sink.snapshot(this.#headless.size, this.#headless.snapshot());
    const tail = this.#tail.bytes;
    if (tail.length > 0) attachment.output(tail);
  }
}

class ClientAttachment implements TerminalAttachment {
  readonly sink: StreamSink;
  readonly #session: TerminalSession;
  readonly #credit = new OutputCredit();

  constructor(session: TerminalSession, sink: StreamSink) {
    this.#session = session;
    this.sink = sink;
  }

  sendSnapshot(): void {
    this.#session.snapshotFor(this);
  }

  /** Live output that the headless terminal has already parsed. */
  deliver(chunk: Uint8Array): void {
    if (this.#credit.admit()) this.output(chunk);
  }

  output(bytes: Uint8Array): void {
    this.sink.output(bytes);
    this.#credit.sent(bytes.length);
  }

  /** A client that missed output would never see the end of it, so it gets the final screen. */
  exit(exit: TerminalExit): void {
    if (this.#credit.missedOutput) this.sendSnapshot();
    this.sink.exit(exit);
  }

  input(bytes: Uint8Array): void {
    this.#session.write(bytes);
  }

  resize(size: TerminalSize): void {
    this.#session.resize(size);
  }

  ack(bytes: number): void {
    if (this.#credit.acked(bytes)) this.sendSnapshot();
  }

  detach(): void {
    this.#session.detach(this);
  }
}
