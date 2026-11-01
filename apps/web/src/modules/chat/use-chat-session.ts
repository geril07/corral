import type { ChatStore } from "@corral/client/chat-store";
import type { CorralClient } from "@corral/client/corral-client";
import type { ChatAnswer } from "@corral/protocol/chat";
import type { ChatSendMode, Session } from "@corral/protocol/rpc";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

/** What the workspace needs to show one session's chat and act on it. */
export interface ChatSessionHandle {
  store: ChatStore;
  send: (text: string, mode: ChatSendMode) => Promise<void>;
  abort: () => Promise<void>;
  respond: (requestId: string, value: ChatAnswer) => Promise<void>;
}

/**
 * Opens the chat store of the selected session while it is a running chat view, and closes it when
 * the selection changes. Nothing is opened for a stopped session: its pane is the stopped-session
 * view, and the store would only record a `CHAT_UNAVAILABLE(exited)` failure nobody reads.
 */
export function useChatSession(
  client: CorralClient,
  session: Session | undefined,
): ChatSessionHandle | undefined {
  const sessionId =
    session?.view === "chat" && session.state === "running" ? session.id : undefined;
  const store = useMemo(
    () => (sessionId === undefined ? undefined : client.openChat(sessionId)),
    [client, sessionId],
  );
  useEffect(() => () => store?.close(), [store]);
  const send = useCallback(
    async (text: string, mode: ChatSendMode) => {
      if (sessionId === undefined) return;
      await client.connection.api.chat.send({ sessionId, text, mode });
    },
    [client, sessionId],
  );
  const abort = useCallback(async () => {
    if (sessionId === undefined) return;
    await client.connection.api.chat.abort({ sessionId });
  }, [client, sessionId]);
  const respond = useCallback(
    async (requestId: string, value: ChatAnswer) => {
      if (sessionId === undefined) return;
      await client.connection.api.chat.respond({ sessionId, requestId, value });
    },
    [client, sessionId],
  );
  return store === undefined || sessionId === undefined
    ? undefined
    : { store, send, abort, respond };
}

const NEVER_SUBSCRIBE = () => () => {};

/** The turn only, so the palette's abort action updates on turn changes and not on every delta. */
export function useChatTurn(store: ChatStore | undefined) {
  return useSyncExternalStore(
    store?.subscribe ?? NEVER_SUBSCRIBE,
    () => store?.getSnapshot().state.turn ?? "idle",
  );
}
