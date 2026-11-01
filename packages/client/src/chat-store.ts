import type { ChatStreamMessage } from "@corral/protocol/chat";
import type { ChatWatchInput, SessionId } from "@corral/protocol/rpc";
import { applyChatMessage, initialChatSnapshot, type ChatStoreSnapshot } from "./chat-state.ts";
import type { ConnectionState } from "./connection-state.ts";
import { Store, type ReadableStore } from "./store.ts";

/**
 * What a chat store needs from the client's connection. `CorralClient` builds it from the RPC
 * connection; a test can drive a stream without a server, which is how the sequencing rules are
 * proved until B1 implements `chat.watch`.
 */
export interface ChatSource {
  /** The connection the store follows: it watches while connected and asks again when it returns. */
  readonly state: ReadableStore<ConnectionState>;
  /** `chat.watch`; `after` is the last sequence the store applied. */
  watch(input: ChatWatchInput): Promise<AsyncIterable<ChatStreamMessage>>;
}

export interface ChatStore extends ReadableStore<ChatStoreSnapshot> {
  close(): void;
}

/**
 * Follows one session's chat: applies the snapshot and the sequenced events, and after a dropped
 * connection asks for the events it missed (`after`) instead of starting over. A hole in the
 * sequence, or an event that does not fit the timeline, makes it watch once more without `after`,
 * which the server answers with a fresh snapshot.
 */
export function createChatStore(source: ChatSource, sessionId: SessionId): ChatStore {
  const store = new Store<ChatStoreSnapshot>(initialChatSnapshot);
  /** The follow allowed to write; a reconnect or `close` replaces it and earlier ones go quiet. */
  let following: object | undefined;

  async function follow(token: object): Promise<void> {
    if (!(await watchOnce(token, false))) return;
    if (!(await watchOnce(token, true))) return;
    // Even the fresh snapshot did not line up with the next event; retrying would spin.
    console.error("chat.watch stayed out of sequence after a resync");
  }

  /**
   * One `chat.watch` call: applies messages until the stream ends or a hole appears. Returns
   * whether it stopped on a hole; `resyncing` says `after` was already omitted for a snapshot.
   */
  async function watchOnce(token: object, resyncing: boolean): Promise<boolean> {
    const { sequence } = store.getSnapshot();
    const input: ChatWatchInput =
      resyncing || sequence === null ? { sessionId } : { sessionId, after: sequence };
    let gap = false;
    try {
      const messages = await source.watch(input);
      for await (const message of messages) {
        if (following !== token) return false;
        const applied = applyChatMessage(store.getSnapshot(), message);
        if (applied.type === "resync") {
          gap = true;
          break;
        }
        store.set(applied.snapshot);
      }
    } catch (error) {
      // A dropped socket ends the call; the connection state starts a new one when it returns.
      // Stopping the abandoned iterator can also throw (oRPC cancels it); the resync below stays
      // valid, so only a failure without a hole ends the follow.
      if (!gap) {
        if (following === token) console.error("chat.watch failed", error);
        return false;
      }
    }
    return gap;
  }

  const sync = () => {
    const connected = source.state.getSnapshot().status === "connected";
    if (connected && !following) {
      following = {};
      void follow(following);
    } else if (!connected) {
      following = undefined;
    }
  };
  const unsubscribe = source.state.subscribe(sync);
  sync();

  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,
    close: () => {
      unsubscribe();
      following = undefined;
    },
  };
}
