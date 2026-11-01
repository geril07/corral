import type { ChatStreamMessage } from "@corral/protocol/chat";
import type { ChatWatchInput, SessionId } from "@corral/protocol/rpc";
import {
  applyChatMessage,
  initialChatSnapshot,
  type ChatFailure,
  type ChatStoreSnapshot,
} from "./chat-state.ts";
import type { ConnectionState } from "./connection-state.ts";
import { chatUnavailableReason, describeError } from "./rpc-errors.ts";
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

/** How one `chat.watch` call ended. Any of these but `interrupted` means the client must decide. */
type WatchOutcome =
  | { type: "interrupted" }
  /** The server ended the iterator cleanly; the contract lets it, so the client watches again. */
  | { type: "ended" }
  | { type: "failed"; failure: ChatFailure }
  /** A message did not continue the client's sequence; a snapshot is needed. */
  | { type: "hole" };

/**
 * Follows one session's chat: applies the snapshot and the sequenced events, and after a dropped
 * connection asks for the events it missed (`after`) instead of starting over. A hole in the
 * sequence, or an event that does not fit the timeline, makes it watch once more without `after`,
 * which the server answers with a fresh snapshot.
 *
 * A stream that ends cleanly is not the end of the chat: the server may end it, so the store
 * watches again once immediately. If that attempt also ends, fails or stays out of sequence, the
 * store records `failure` and waits for the next connection change; it never retries in a loop.
 */
export function createChatStore(source: ChatSource, sessionId: SessionId): ChatStore {
  const store = new Store<ChatStoreSnapshot>(initialChatSnapshot);
  /** The follow allowed to write; a reconnect or `close` replaces it and earlier ones go quiet. */
  let following: object | undefined;

  async function follow(token: object): Promise<void> {
    try {
      const first = await watchAttempt(token);
      if (first.type === "interrupted") return;
      // Every other outcome means the stream stopped. One immediate retry, then the next
      // connection change starts a new follow because `following` is cleared below.
      const retry = await watchAttempt(token);
      if (retry.type === "interrupted") return;
      store.set({ ...store.getSnapshot(), failure: stoppedFailure(retry) });
    } finally {
      if (following === token) following = undefined;
    }
  }

  /** One protocol attempt: the normal watch, plus the snapshot watch when the stream had a hole. */
  async function watchAttempt(token: object): Promise<WatchOutcome> {
    const first = await watchOnce(token, false);
    return first.type === "hole" ? watchOnce(token, true) : first;
  }

  /** One `chat.watch` call; `resyncing` says `after` was already omitted to ask for a snapshot. */
  async function watchOnce(token: object, resyncing: boolean): Promise<WatchOutcome> {
    const { sequence } = store.getSnapshot();
    const input: ChatWatchInput =
      resyncing || sequence === null ? { sessionId } : { sessionId, after: sequence };
    let gap = false;
    try {
      const messages = await source.watch(input);
      if (following !== token) return { type: "interrupted" };
      // The call was accepted, so a failure from the previous attempt is no longer the situation.
      if (store.getSnapshot().failure !== null) {
        store.set({ ...store.getSnapshot(), failure: null });
      }
      for await (const message of messages) {
        if (following !== token) return { type: "interrupted" };
        const applied = applyChatMessage(store.getSnapshot(), message);
        if (applied.type === "resync") {
          gap = true;
          break;
        }
        store.set(applied.snapshot);
      }
    } catch (error) {
      if (following !== token) return { type: "interrupted" };
      // Stopping the abandoned iterator can also throw (oRPC cancels it); a hole stays a hole, and
      // the caller decides whether a snapshot attempt can fix it.
      if (gap) return { type: "hole" };
      const failure = failureOf(error);
      console.error("chat.watch failed", failure);
      store.set({ ...store.getSnapshot(), failure });
      return { type: "failed", failure };
    }
    if (following !== token) return { type: "interrupted" };
    return gap ? { type: "hole" } : { type: "ended" };
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

/** The wire error code when the failure did not come from one. */
const CHAT_WATCH_FAILED = "CHAT_WATCH_FAILED";

/**
 * The failure an RPC refusal or a dropped stream becomes. The sentence comes from
 * `describeError`, which reads a refusal's `data.message`: an `ORPCError`'s own `message` is only
 * its code on the wire, and that code is not what a user should read.
 */
function failureOf(error: unknown): ChatFailure {
  const reason = chatUnavailableReason(error);
  return {
    code: errorCode(error),
    message: describeError(error),
    ...(reason === undefined ? {} : { reason }),
  };
}

/** The RPC code an error carries, or a client-side one when it carries none. */
function errorCode(error: unknown): string {
  if (error instanceof Error && "code" in error) {
    const code = error.code;
    if (typeof code === "string") return code;
  }
  return CHAT_WATCH_FAILED;
}

/** The failure to record after two attempts stopped without continuing the chat. */
function stoppedFailure(outcome: WatchOutcome): ChatFailure {
  switch (outcome.type) {
    case "hole":
      return {
        code: "CHAT_OUT_OF_SEQUENCE",
        message: "The chat stream stayed out of sequence after a fresh snapshot.",
      };
    case "failed":
      return outcome.failure;
    case "ended":
      return {
        code: "CHAT_STREAM_ENDED",
        message: "The chat stream ended and did not continue when watched again.",
      };
    case "interrupted":
      // Not a stop: the caller returned before asking, so this is never stored.
      return { code: CHAT_WATCH_FAILED, message: "The chat stream was interrupted." };
  }
  // The union is exhausted above; this only spells out the impossible path for the linter.
  return { code: CHAT_WATCH_FAILED, message: "The chat stream stopped." };
}
