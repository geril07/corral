import { ACK_RESUME_BYTES, ACK_WINDOW_BYTES } from "@corral/protocol/terminal-stream";

/**
 * Flow-control state of one attached client, as specified in `terminal-stream.ts`: past
 * `ACK_WINDOW_BYTES` unacked the client gets no more output, and once acks bring it down to
 * `ACK_RESUME_BYTES` it gets a fresh snapshot in place of what it missed.
 */
export class OutputCredit {
  #unacked = 0;
  #stalled = false;
  #skippedOutput = false;

  get unackedBytes(): number {
    return this.#unacked;
  }

  /** True while the client has missed output that no snapshot has replaced yet. */
  get missedOutput(): boolean {
    return this.#skippedOutput;
  }

  /** True when the client may receive these bytes; otherwise they count as skipped. */
  admit(): boolean {
    if (this.#stalled) this.#skippedOutput = true;
    return !this.#stalled;
  }

  sent(bytes: number): void {
    this.#unacked += bytes;
    if (this.#unacked > ACK_WINDOW_BYTES) this.#stalled = true;
  }

  /** True when the client has caught up after skipped output and needs a snapshot now. */
  acked(bytes: number): boolean {
    this.#unacked = Math.max(0, this.#unacked - bytes);
    if (!this.#stalled || this.#unacked > ACK_RESUME_BYTES) return false;
    this.#stalled = false;
    const needsSnapshot = this.#skippedOutput;
    this.#skippedOutput = false;
    return needsSnapshot;
  }
}
