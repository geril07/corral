import type { ChatSessionState } from "@corral/protocol/chat";
import type { ChatStoreSnapshot } from "@corral/client/chat-state";
import type { ChatStore } from "@corral/client/chat-store";
import type { CorralClient } from "@corral/client/corral-client";
import type { SessionsSnapshot } from "@corral/client/sessions-store";
import { Store } from "@corral/client/store";
import type { TasksSnapshot } from "@corral/client/tasks-store";
import type { Session, Task } from "@corral/protocol/rpc";
import { ORPCError } from "@orpc/client";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { agentLaunches } from "../../../test/fake-agents.ts";
import { prefixShifted, prefixThen, realServerClients } from "../../../test/real-client.ts";
import { appWithProject } from "../../../test/task-flows.tsx";
import { workingChat } from "../../../test/recorded-chat.ts";

const { newClient } = realServerClients();

/**
 * A running chat session and its task are seeded through the client's own stores. The server owns
 * sessions and has no driver before B1, and a real task here would outlive this file on the shared
 * server; `openChat` returns a working chat so the abort action is enabled.
 */
function seededClient(
  state: ChatSessionState = workingChat(),
  setModelImpl: (input: {
    sessionId: string;
    model: { provider: string | null; id: string };
  }) => Promise<void> = async () => undefined,
) {
  const real = newClient();
  const abort = vi
    .fn<(input: { sessionId: string }) => Promise<void>>()
    .mockResolvedValue(undefined);
  const setModel = vi
    .fn<
      (input: {
        sessionId: string;
        model: { provider: string | null; id: string };
      }) => Promise<void>
    >()
    .mockImplementation(setModelImpl);
  const setReasoning = vi
    .fn<(input: { sessionId: string; level: string }) => Promise<void>>()
    .mockResolvedValue(undefined);
  const api = new Proxy(real.connection.api, {
    get(target, property, receiver) {
      if (property !== "chat") return Reflect.get(target, property, receiver);
      const chat = Reflect.get(target, property, receiver) as object;
      return new Proxy(chat, {
        get(chatTarget, chatProperty, chatReceiver) {
          if (chatProperty === "abort") return abort;
          if (chatProperty === "setModel") return setModel;
          if (chatProperty === "setReasoning") return setReasoning;
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
    state,
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
      failure: { subscribe: () => () => {}, getSnapshot: () => undefined },
      retry: () => {},
      close: () => {},
    },
    sessions: {
      subscribe: sessions.subscribe,
      getSnapshot: sessions.getSnapshot,
      failure: { subscribe: () => () => {}, getSnapshot: () => undefined },
      retry: () => {},
      close: () => {},
    },
    connection,
    openChat: () => chatStore,
  };
  return {
    client,
    real,
    tasks,
    sessions,
    abort,
    setModel,
    setReasoning,
    chatStore,
    chatSession: "chat-seeded",
  };
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

    await composer.fill("Unsent pi draft");
    sessions.set({
      loaded: true,
      sessions: [
        session,
        {
          ...session,
          id: "second-chat",
          kind: "codex",
          agentSessionId: "codex-seeded",
          createdAt: 2,
        },
      ],
    });
    await page.getByRole("tab", { name: /^codex/ }).click();
    await expect.element(composer).toHaveValue("");
    await composer.fill("Unsent codex draft");
    await page.getByRole("tab", { name: /^pi/ }).click();
    await expect.element(composer).toHaveValue("Unsent pi draft");
    await page.getByRole("tab", { name: /^codex/ }).click();
    await expect.element(composer).toHaveValue("Unsent codex draft");
    await page.getByRole("tab", { name: /^pi/ }).click();
    await expect.element(composer).toHaveValue("Unsent pi draft");

    // The board is a layer over the mounted workspace, so its round trip keeps the chat draft.
    await prefixThen("b");
    await expect.element(page.getByRole("region", { name: "Board" })).toBeVisible();
    await expect
      .element(page.getByRole("region", { name: "Board" }).getByRole("listbox"))
      .toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("region", { name: "Board" })).not.toBeInTheDocument();
    await expect.element(composer).toHaveValue("Unsent pi draft");

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

test("the chat model and reasoning controls apply what the driver reports, from the row and the palette", async () => {
  const state = workingChat({
    model: { provider: "stub", id: "stub-1", name: "Stub One" },
    models: [
      { provider: "stub", id: "stub-1", name: "Stub One" },
      { provider: "stub", id: "stub-2", name: "Stub Two" },
    ],
    reasoning: "medium",
    reasoningLevels: ["off", "low", "medium", "high"],
  });
  const { client, real, tasks, sessions, setModel, setReasoning, chatStore, chatSession } =
    seededClient(state);
  const { repo } = await appWithProject(client);
  const project = await vi.waitFor(() => {
    const found = real.projects.getSnapshot().projects.find((each) => each.path === repo);
    if (found === undefined) throw new Error("the project is not in the list yet");
    return found;
  });
  await vi.waitFor(() => expect(real.sessions.getSnapshot().loaded).toBe(true));

  const task: Task = {
    id: "task-chat-settings",
    projectId: project.id,
    title: "Chat settings",
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

    // The row shows what the driver reported, not a client guess.
    await expect.element(page.getByRole("button", { name: "Model Stub One" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Reasoning medium" })).toBeVisible();

    // The palette lists both actions for a running chat and opens the model chooser.
    await prefixThen(" ");
    await userEvent.keyboard("chat model");
    await expect
      .element(page.getByRole("option", { name: /Change the chat model/ }))
      .not.toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Enter}");
    const modelDialog = page.getByRole("dialog", { name: "Chat model" });
    await expect.element(modelDialog).toBeVisible();
    await expect.element(modelDialog).toMatchTextContent("Stub Two");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await vi.waitFor(() =>
      expect(setModel).toHaveBeenCalledExactlyOnceWith({
        sessionId: chatSession,
        model: { provider: "stub", id: "stub-2" },
      }),
    );
    await expect.element(modelDialog).toBeVisible();
    await expect
      .element(modelDialog)
      .toMatchTextContent("Waiting for the agent\u0027s updated model");
    await expect
      .element(modelDialog.getByRole("toolbar", { name: "Thinking" }))
      .not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await expect.element(modelDialog).not.toBeInTheDocument();
    await expect.element(page.getByRole("textbox", { name: "Message" })).toHaveFocus();

    // The row\u0027s reasoning picker opens the level list; the driver's own values are what it offers.
    await page.getByRole("button", { name: "Reasoning medium" }).click();
    const levelDialog = page.getByRole("dialog", { name: "Reasoning level" });
    await expect.element(levelDialog).toBeVisible();
    await userEvent.keyboard("{ArrowDown}{Enter}");
    await vi.waitFor(() =>
      expect(setReasoning).toHaveBeenCalledExactlyOnceWith({
        sessionId: chatSession,
        level: "high",
      }),
    );
    await expect.element(levelDialog).not.toBeInTheDocument();

    // `prefix shift+m` reaches the same reasoning action from the keyboard.
    await prefixShifted("m");
    await expect.element(levelDialog).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(levelDialog).not.toBeInTheDocument();
  } finally {
    tasks.set({ loaded: true, tasks: [] });
    sessions.set({ loaded: true, sessions: [] });
    chatStore.close();
  }
});

test("a refused model keeps the chooser open with a sentence, not the RPC code", async () => {
  const state = workingChat({
    model: { provider: "stub", id: "stub-1", name: "Stub One" },
    models: [
      { provider: "stub", id: "stub-1", name: "Stub One" },
      { provider: "stub", id: "stub-2", name: "Stub Two" },
    ],
    reasoning: "medium",
    reasoningLevels: ["off", "medium", "high"],
  });
  const { client, real, tasks, sessions, chatStore, chatSession } = seededClient(
    state,
    async () => {
      throw new ORPCError("CHAT_MODEL_UNSUPPORTED", {
        defined: true,
        data: { model: { provider: "stub", id: "stub-2" } },
      });
    },
  );
  const { repo } = await appWithProject(client);
  const project = await vi.waitFor(() => {
    const found = real.projects.getSnapshot().projects.find((each) => each.path === repo);
    if (found === undefined) throw new Error("the project is not in the list yet");
    return found;
  });
  await vi.waitFor(() => expect(real.sessions.getSnapshot().loaded).toBe(true));

  const task: Task = {
    id: "task-chat-refused",
    projectId: project.id,
    title: "Refused model",
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

    await page.getByRole("button", { name: "Model Stub One" }).click();
    const dialog = page.getByRole("dialog", { name: "Chat model" });
    await expect.element(dialog).toBeVisible();
    await userEvent.keyboard("{ArrowDown}{Enter}");

    // The server's data, in a sentence: the list stays open so the user can pick another model.
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog).toMatchTextContent("does not offer the model stub-2");
    await expect.element(dialog).not.toMatchTextContent("CHAT_MODEL_UNSUPPORTED");
  } finally {
    tasks.set({ loaded: true, tasks: [] });
    sessions.set({ loaded: true, sessions: [] });
    chatStore.close();
  }
});
