import type { ChatStoreSnapshot } from "@corral/client/chat-state";
import type { ChatStore } from "@corral/client/chat-store";
import type { CorralClient } from "@corral/client/corral-client";
import type { SessionsSnapshot } from "@corral/client/sessions-store";
import { Store } from "@corral/client/store";
import type { TasksSnapshot } from "@corral/client/tasks-store";
import type { Session, Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { agentLaunches } from "../../../test/fake-agents.ts";
import { prefixThen, realServerClients } from "../../../test/real-client.ts";
import { appWithProject } from "../../../test/task-flows.tsx";
import { workingChat } from "../../../test/recorded-chat.ts";

const { newClient } = realServerClients();

/**
 * A running chat session and its task are seeded through the client's own stores. The server owns
 * sessions and has no driver before B1, and a real task here would outlive this file on the shared
 * server; `openChat` returns a working chat so the abort action is enabled.
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
  const tasks = new Store<TasksSnapshot>({ loaded: true, tasks: [] });
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
    tasks: {
      subscribe: tasks.subscribe,
      getSnapshot: tasks.getSnapshot,
      close: () => {},
    },
    sessions: {
      subscribe: sessions.subscribe,
      getSnapshot: sessions.getSnapshot,
      close: () => {},
    },
    connection,
    openChat: () => chatStore,
  };
  return { client, real, tasks, sessions, abort, chatStore, chatSession: "chat-seeded" };
}

test("a chat session renders its tab and lane, and prefix . reaches chat.abort", async () => {
  const { client, real, tasks, sessions, abort, chatStore, chatSession } = seededClient();
  const { repo } = await appWithProject(client);
  const project = await vi.waitFor(() => {
    const found = real.projects.getSnapshot().projects.find((each) => each.path === repo);
    if (found === undefined) throw new Error("the project is not in the list yet");
    return found;
  });
  await vi.waitFor(() => expect(real.sessions.getSnapshot().loaded).toBe(true));

  const task: Task = {
    id: "task-chat",
    projectId: project.id,
    title: "Chat tab",
    titleSource: "user",
    prompt: null,
    primarySessionId: chatSession,
    branch: "main",
    workspacePath: project.path,
    ownsWorktree: false,
    state: "active",
    seenAt: null,
    createdAt: 1,
  };
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

  try {
    tasks.set({ loaded: true, tasks: [task] });
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
  } finally {
    // Nothing here reached the server as a task, session or driver; close what we seeded and prove
    // the server stayed clean so the next file starts from its own defaults.
    tasks.set({ loaded: true, tasks: [] });
    sessions.set({ loaded: true, sessions: [] });
    chatStore.close();
    expect(real.sessions.getSnapshot().sessions.some((each) => each.id === chatSession)).toBe(
      false,
    );
    const open = await real.connection.api.terminals.list();
    expect(open.some((terminal) => terminal.sessionId === chatSession)).toBe(false);
    expect(open.some((terminal) => terminal.taskId === task.id)).toBe(false);
    // The seeded chat never reached B1's driver: no fake pi child was launched for it.
    const launches = await agentLaunches();
    expect(launches.some((launch) => launch.argv.includes("pi-seeded"))).toBe(false);
  }
});
