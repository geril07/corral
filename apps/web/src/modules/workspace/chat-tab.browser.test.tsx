import type { ChatStoreSnapshot } from "@corral/client/chat-state";
import type { ChatStore } from "@corral/client/chat-store";
import type { CorralClient } from "@corral/client/corral-client";
import type { SessionsSnapshot } from "@corral/client/sessions-store";
import { Store } from "@corral/client/store";
import type { Session } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { prefixThen, realServerClients } from "../../../test/real-client.ts";
import { appWithProject, createTask } from "../../../test/task-flows.tsx";
import { workingChat } from "../../../test/recorded-chat.ts";

const { newClient } = realServerClients();

/**
 * A running chat session is seeded through the client's own stores: the server owns sessions and
 * has no driver before B1, so the workspace wiring is exercised against the same `Store` shape
 * the watch stores expose. `openChat` returns a working chat so the abort action is enabled.
 */
function seededClient() {
  const real = newClient();
  const abort = vi
    .fn<(input: { sessionId: string }) => Promise<void>>()
    .mockResolvedValue(undefined);
  const api = new Proxy(real.connection.api, {
    get(target, property, receiver) {
      if (property !== "chat") return Reflect.get(target, property, receiver);
      const chat = Reflect.get(target, property, receiver) as object;
      return new Proxy(chat, {
        get(chatTarget, chatProperty, chatReceiver) {
          if (chatProperty === "abort") return abort;
          return Reflect.get(chatTarget, chatProperty, chatReceiver);
        },
      });
    },
  });
  const connection = { ...real.connection, api } as CorralClient["connection"];
  const sessions = new Store<SessionsSnapshot>({ loaded: true, sessions: [] });
  const chatState = new Store<ChatStoreSnapshot>({
    loaded: true,
    sequence: 0,
    state: workingChat(),
    items: [],
    failure: null,
  });
  const chatStore: ChatStore = {
    subscribe: chatState.subscribe,
    getSnapshot: chatState.getSnapshot,
    close: () => {},
  };
  const client: CorralClient = {
    ...real,
    sessions: {
      subscribe: sessions.subscribe,
      getSnapshot: sessions.getSnapshot,
      close: () => {},
    },
    connection,
    openChat: () => chatStore,
  };
  return { client, real, sessions, abort, chatSession: "chat-seeded" };
}

test("a chat session renders its tab and lane, and prefix . reaches chat.abort", async () => {
  const { client, real, sessions, abort, chatSession } = seededClient();
  await appWithProject(client);
  await createTask("Chat tab");

  const task = await vi.waitFor(() => {
    const found = real.tasks.getSnapshot().tasks.find((each) => each.title === "Chat tab");
    if (found === undefined) throw new Error("the task is not in the list yet");
    return found;
  });
  const session: Session = {
    id: chatSession,
    taskId: task.id,
    kind: "pi",
    view: "chat",
    agentSessionId: "pi-seeded",
    terminalId: null,
    state: "running",
    status: null,
    createdAt: 1,
  };
  sessions.set({ loaded: true, sessions: [session] });

  // The workspace picks the only session of the task and renders the chat lane, not a terminal.
  await expect.element(page.getByRole("log", { name: "Chat transcript" })).toBeVisible();
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect.element(composer).toBeVisible();
  await expect
    .element(page.getByRole("tab", { name: /^pi/ }))
    .toHaveAttribute("aria-selected", "true");

  // The palette action is enabled for a working chat turn.
  await prefixThen(" ");
  await userEvent.keyboard("abort");
  const paletteItem = page.getByRole("option", { name: /Abort the working turn/ });
  await expect.element(paletteItem).not.toHaveAttribute("aria-disabled", "true");
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("dialog", { name: "Command palette" }))
    .not.toBeInTheDocument();

  // `prefix .` runs the action's `chat.abort` with the selected session.
  composer.element().focus();
  await expect.element(composer).toHaveFocus();
  await prefixThen(".");
  await vi.waitFor(() => expect(abort).toHaveBeenCalledWith({ sessionId: chatSession }));
});
