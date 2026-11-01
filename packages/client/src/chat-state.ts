import type {
  ChatEvent,
  ChatItem,
  ChatSessionState,
  ChatStreamMessage,
} from "@corral/protocol/chat";

/** Why a chat stream stopped, when it did; `code` is the RPC error code or a client-side one. */
export interface ChatFailure {
  code: string;
  message: string;
}

/** What a chat store holds: the session state, the timeline, and the sequence both are at. */
export interface ChatStoreSnapshot {
  /** False until the first snapshot has been applied; the rest is empty until then. */
  loaded: boolean;
  /** The last sequence applied; `null` before the first snapshot. */
  sequence: number | null;
  state: ChatSessionState;
  items: readonly ChatItem[];
  /** Why the last watch stopped, so a frozen view can say so; cleared by the next applied message. */
  failure: ChatFailure | null;
}

/** The chat of a session before anything has arrived: idle, no items. */
export const initialChatSnapshot: ChatStoreSnapshot = {
  loaded: false,
  sequence: null,
  state: {
    turn: "idle",
    steering: [],
    followUp: [],
    model: null,
    models: [],
    reasoning: null,
    reasoningLevels: [],
  },
  items: [],
  failure: null,
};

/** `applied` carries the next snapshot; `resync` means the stream was not contiguous. */
export type ChatApply = { type: "applied"; snapshot: ChatStoreSnapshot } | { type: "resync" };

/**
 * Applies one message of `chat.watch`. A snapshot replaces everything; an event must be the next
 * sequence, or the client cannot know what it missed and must ask for a snapshot again.
 */
export function applyChatMessage(
  current: ChatStoreSnapshot,
  message: ChatStreamMessage,
): ChatApply {
  if (message.type === "snapshot") {
    return { type: "applied", snapshot: { loaded: true, failure: null, ...message.snapshot } };
  }
  if (!current.loaded || current.sequence === null || message.sequence !== current.sequence + 1) {
    return { type: "resync" };
  }
  const applied = applyChatEvent(current, message.event);
  return applied === undefined
    ? { type: "resync" }
    : {
        type: "applied",
        snapshot: {
          loaded: true,
          failure: null,
          sequence: message.sequence,
          state: applied.state,
          items: applied.items,
        },
      };
}

/** The state and items after one event; `undefined` when the event does not fit the timeline. */
function applyChatEvent(
  current: ChatStoreSnapshot,
  event: ChatEvent,
): { state: ChatSessionState; items: readonly ChatItem[] } | undefined {
  switch (event.type) {
    case "item":
      return { state: current.state, items: replaceOrAppend(current.items, event.item) };
    case "delta": {
      const index = current.items.findIndex((item) => item.id === event.itemId);
      const item = index === -1 ? undefined : current.items[index];
      if (item === undefined) return undefined;
      // Only the two text items stream; a delta for anything else means the client lost an item.
      if (item.kind !== "assistant-message" && item.kind !== "reasoning") return undefined;
      return {
        state: current.state,
        items: current.items.with(index, { ...item, text: item.text + event.text }),
      };
    }
    case "state":
      return { state: event.state, items: current.items };
  }
  // Every event type is handled above; this only spells out the impossible path for the linter.
  return undefined;
}

function replaceOrAppend(items: readonly ChatItem[], item: ChatItem): readonly ChatItem[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  return index === -1 ? [...items, item] : items.with(index, item);
}
