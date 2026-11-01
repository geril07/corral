import type {
  ChatEvent,
  ChatItem,
  ChatSessionState,
  ChatSnapshot,
  ChatStreamMessage,
} from "@corral/protocol/chat";

/** The state before anything has happened: idle, no model reported yet. */
export function emptyChatState(): ChatSessionState {
  return {
    turn: "idle",
    steering: [],
    followUp: [],
    model: null,
    models: [],
    reasoning: null,
    reasoningLevels: [],
  };
}

/**
 * How many events a client may miss and still be caught up by `chat.watch({ after })`. Beyond
 * this the server answers with a fresh snapshot, which the contract allows at any time; keeping
 * the whole event log would grow with the conversation for no gain.
 */
export const MAX_REPLAYED_EVENTS = 512;

/**
 * One session's chat as the server streams it: the timeline, the session-level state and the
 * sequence both are at. The pi projection writes items, deltas and state here; `watch` reads them.
 * Sequence numbers are per session, contiguous and start at 1 (the chat contract's rule).
 */
export class ChatTimeline {
  /**
   * The sequence the timeline starts at. A server restart rebuilds a session's chat from pi, and a
   * client keeps the cursor it had before; replaying a cursor from the timeline this one replaced
   * would apply events to a stale item list. `after` below `startAt` is therefore a hole and is
   * answered with a snapshot, and a frontend recreated in this run starts above its predecessor.
   */
  readonly #startAt: number;
  #sequence: number;
  #state: ChatSessionState = emptyChatState();
  #items: ChatItem[] = [];
  #indexById = new Map<string, number>();
  #events: { sequence: number; event: ChatEvent }[] = [];
  #listeners = new Set<() => void>();
  #closed = false;

  constructor(startAt = 0) {
    if (!Number.isInteger(startAt) || startAt < 0) throw new Error(`bad chat start ${startAt}`);
    this.#startAt = startAt;
    this.#sequence = startAt;
  }

  get sequence(): number {
    return this.#sequence;
  }

  get state(): ChatSessionState {
    return this.#state;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The item with this id, or undefined. */
  item(id: string): ChatItem | undefined {
    const index = this.#indexById.get(id);
    return index === undefined ? undefined : this.#items[index];
  }

  snapshot(): ChatSnapshot {
    return { sequence: this.#sequence, state: { ...this.#state }, items: [...this.#items] };
  }

  /** Appends an item, or replaces the one with the same id in place, and streams it. */
  put(item: ChatItem): void {
    const index = this.#indexById.get(item.id);
    if (index === undefined) {
      this.#indexById.set(item.id, this.#items.length);
      this.#items = [...this.#items, item];
    } else {
      this.#items = this.#items.with(index, item);
    }
    this.#emit({ type: "item", item });
  }

  /**
   * Appends streamed text: the snapshot's item grows as well, so a client that arrives mid-stream
   * gets the text so far and still receives the increment as a delta.
   */
  appendText(itemId: string, text: string): void {
    if (text === "") return;
    const index = this.#indexById.get(itemId);
    const item = index === undefined ? undefined : this.#items[index];
    if (
      index !== undefined &&
      item !== undefined &&
      (item.kind === "assistant-message" || item.kind === "reasoning")
    ) {
      this.#items = this.#items.with(index, { ...item, text: item.text + text });
    }
    this.#emit({ type: "delta", itemId, text });
  }

  /** Replaces the whole session state and streams it. */
  setState(patch: Partial<ChatSessionState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#emit({ type: "state", state: { ...this.#state } });
  }

  /** The events after `after`, or undefined when they are gone and only a snapshot can help. */
  eventsAfter(after: number): { sequence: number; event: ChatEvent }[] | undefined {
    if (!Number.isInteger(after) || after < 0 || after > this.#sequence) return undefined;
    // A cursor from the timeline this one replaced: no event of this timeline is newer than it by
    // definition, so only a snapshot can put the client on this timeline's items.
    if (after < this.#startAt) return undefined;
    const oldest = this.#events[0]?.sequence;
    if (oldest !== undefined && after + 1 < oldest) return undefined;
    return this.#events.filter((entry) => entry.sequence > after);
  }

  /** Ends every watch once the events that are already there have been delivered. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#notify();
  }

  /**
   * `chat.watch`: a snapshot when `after` is absent or no longer replayable, else the missed
   * events, then every later event. Ends after the last event when the session's frontend is
   * closed and the server still serves the events; the client then gets the refusal that says so.
   */
  async *watch(
    after: number | undefined,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<ChatStreamMessage> {
    let cursor = after;
    const replay = cursor === undefined ? undefined : this.eventsAfter(cursor);
    if (cursor === undefined || replay === undefined) {
      // Take the snapshot and the cursor together: an event emitted between the two yields would
      // otherwise be skipped by the client that is about to receive the snapshot without it.
      const snapshot = this.snapshot();
      cursor = snapshot.sequence;
      yield { type: "snapshot", snapshot };
    } else {
      for (const entry of replay) {
        yield { type: "event", sequence: entry.sequence, event: entry.event };
        cursor = entry.sequence;
      }
    }
    let wake: (() => void) | undefined;
    const listener = () => wake?.();
    const onAbort = () => wake?.();
    this.#listeners.add(listener);
    signal?.addEventListener("abort", onAbort);
    try {
      // oxlint-disable-next-line no-unmodified-loop-condition -- `aborted` flips from the abort listener
      while (!signal?.aborted) {
        const pending = this.eventsAfter(cursor);
        if (pending === undefined) {
          const snapshot = this.snapshot();
          cursor = snapshot.sequence;
          yield { type: "snapshot", snapshot };
          continue;
        }
        if (pending.length > 0) {
          for (const entry of pending) {
            yield { type: "event", sequence: entry.sequence, event: entry.event };
            cursor = entry.sequence;
          }
          continue;
        }
        if (this.#closed) return;
        // oxlint-disable-next-line no-await-in-loop -- one wait per change is the point
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
      }
    } finally {
      this.#listeners.delete(listener);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  #emit(event: ChatEvent): void {
    this.#sequence += 1;
    this.#events.push({ sequence: this.#sequence, event });
    if (this.#events.length > MAX_REPLAYED_EVENTS) this.#events.shift();
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}
