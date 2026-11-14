import type { ChatDriverCapabilities, ChatSessionState } from "@corral/protocol/chat";
import type {
  ChatCapabilitiesSnapshot,
  ChatCapabilitiesStore,
} from "@corral/client/chat-capabilities-store";
import type { ChatStoreSnapshot } from "@corral/client/chat-state";
import type { ChatStore } from "@corral/client/chat-store";
import type { CorralClient } from "@corral/client/corral-client";
import type { SessionsSnapshot } from "@corral/client/sessions-store";
import { Store } from "@corral/client/store";
import type { TasksSnapshot } from "@corral/client/tasks-store";
import type { ChatSendMode, Session, Task } from "@corral/protocol/rpc";
import { ORPCError } from "@orpc/client";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { agentLaunches } from "../../../test/fake-agents.ts";
import { createGitRepo } from "../../../test/git-repo.ts";
import { prefixShifted, prefixThen, realServerClients } from "../../../test/real-client.ts";
import { renderApp } from "../../../test/render-app.tsx";
import { workingChat } from "../../../test/recorded-chat.ts";

const { newClient } = realServerClients();
const openSeededTask = (title: string) =>
  page.getByRole("button", { name: new RegExp(title) }).click();

async function appWithProject(client: CorralClient) {
  await expect.poll(() => client.connection.state.getSnapshot().status).toBe("connected");
  const repo = await createGitRepo("repo");
  await client.connection.api.projects.add({ path: repo });
  const screen = await renderApp(client);
  screen.container.style.height = "100vh";
  return { repo, screen };
}

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
  capabilities?: ChatCapabilitiesStore,
) {
  const real = newClient();
  const send = vi
    .fn<(input: { sessionId: string; text: string; mode: ChatSendMode }) => Promise<string>>()
    .mockResolvedValue("sent-item");
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
          if (chatProperty === "send") return send;
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
    chatCapabilities: capabilities ?? real.chatCapabilities,
    openChat: () => chatStore,
  };
  return {
    client,
    real,
    tasks,
    sessions,
    send,
    abort,
    setModel,
    setReasoning,
    chatStore,
    chatState,
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

    // Adding the project left its composer open over the URL's project; choosing the seeded task
    // leaves it for the chat lane.
    await openSeededTask("Chat tab");
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

    // `prefix .` runs the action's `chat.abort` with the selected session. The pending state
    // lives with the RPC, so this path and the button share the Stopping control and busy row.
    const pendingAbort = Promise.withResolvers<void>();
    abort.mockImplementation(() => pendingAbort.promise);
    composer.element().focus();
    await expect.element(composer).toHaveFocus();
    await prefixThen(".");
    await vi.waitFor(() => expect(abort).toHaveBeenCalledWith({ sessionId: chatSession }));
    const stopping = page.getByRole("button", { name: "Stopping…" });
    await expect.element(stopping).toBeDisabled();
    await expect.element(stopping).toHaveTextContent("Stopping…");
    const row = stopping.element().closest<HTMLElement>("[aria-busy]")!;
    await expect.poll(() => row.getAttribute("aria-busy")).toBe("true");

    pendingAbort.resolve();
    await expect.element(page.getByRole("button", { name: "Abort" })).toBeEnabled();
    await expect.poll(() => row.getAttribute("aria-busy")).toBe("false");

    // A refused button abort clears the same shared state and shows the composer's alert.
    const rejectedAbort = Promise.withResolvers<void>();
    abort.mockImplementation(async () => {
      await rejectedAbort.promise;
      throw new Error("The agent refused the abort.");
    });
    await page.getByRole("button", { name: "Abort" }).click();
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(2));
    await expect.element(page.getByRole("button", { name: "Stopping…" })).toBeDisabled();
    rejectedAbort.resolve();
    await expect.element(page.getByRole("alert")).toHaveTextContent("The agent refused the abort.");
    await expect.element(page.getByRole("button", { name: "Abort" })).toBeEnabled();
    await expect.poll(() => row.getAttribute("aria-busy")).toBe("false");
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

test("the matched driver decides the follow-up offer: Codex has no Queue, pi keeps it", async () => {
  const { client, real, tasks, sessions, send, chatStore, chatSession } = seededClient();
  const { repo } = await appWithProject(client);
  const project = await vi.waitFor(() => {
    const found = real.projects.getSnapshot().projects.find((each) => each.path === repo);
    if (found === undefined) throw new Error("the project is not in the list yet");
    return found;
  });
  await vi.waitFor(() => expect(real.sessions.getSnapshot().loaded).toBe(true));
  // The real server's answer, not a client guess by agent kind.
  await vi.waitFor(() => {
    const kinds = client.chatCapabilities.getSnapshot().drivers.map((driver) => driver.kind);
    expect(kinds).toEqual(expect.arrayContaining(["codex", "pi"]));
  });

  const task: Task = {
    id: "task-chat-follow-up",
    projectId: project.id,
    title: "Follow-up mode",
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
  const codexSession: Session = {
    id: chatSession,
    taskId: task.id,
    kind: "codex",
    view: "chat",
    agentSessionId: "codex-seeded",
    terminalId: null,
    state: "running",
    status: null,
    createdAt: 1,
  };
  const piSession: Session = {
    ...codexSession,
    id: "chat-seeded-pi",
    kind: "pi",
    agentSessionId: "pi-seeded",
    createdAt: 2,
  };

  try {
    tasks.set({ loaded: true, tasks: [task] });
    sessions.set({ loaded: true, sessions: [codexSession, piSession] });

    await openSeededTask("Follow-up mode");
    await expect
      .element(page.getByRole("tab", { name: /^codex/ }))
      .toHaveAttribute("aria-selected", "true");
    const composer = page.getByRole("textbox", { name: "Message" });

    // Codex declares `followUp:false`: the Queue button is absent and no hint sentence returns.
    await expect.element(page.getByRole("button", { name: "Queue" })).not.toBeInTheDocument();
    await expect.element(page.getByText(/Enter steer ·/)).not.toBeInTheDocument();

    // Ctrl+Enter steers the same turn plain Enter does, and the composer keeps its semantics.
    await composer.fill("Steer the Codex turn");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith({
        sessionId: chatSession,
        text: "Steer the Codex turn",
        mode: "steer",
      }),
    );
    await expect.element(composer).toHaveValue("");

    // pi declares `followUp:true`: the offer returns when the selected session changes.
    await page.getByRole("tab", { name: /^pi/ }).click();
    await expect.element(page.getByRole("button", { name: "Queue" })).toBeVisible();
    await composer.fill("Queue for pi");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await vi.waitFor(() =>
      expect(send).toHaveBeenLastCalledWith({
        sessionId: "chat-seeded-pi",
        text: "Queue for pi",
        mode: "follow-up",
      }),
    );
  } finally {
    tasks.set({ loaded: true, tasks: [] });
    sessions.set({ loaded: true, sessions: [] });
    chatStore.close();
    // Seeded sessions never reached a driver: no fake agent child was launched for either id.
    const launches = await agentLaunches();
    expect(launches.some((launch) => launch.argv.includes("codex-seeded"))).toBe(false);
    expect(launches.some((launch) => launch.argv.includes("pi-seeded"))).toBe(false);
  }
});

test("an unknown capability keeps Queue and a loaded Codex answer removes it without reselect", async () => {
  const capabilities = new Store<ChatCapabilitiesSnapshot>({ loaded: false, drivers: [] });
  const capabilityStore: ChatCapabilitiesStore = {
    subscribe: capabilities.subscribe,
    getSnapshot: capabilities.getSnapshot,
    close: () => {},
  };
  const { client, real, tasks, sessions, chatStore, chatSession } = seededClient(
    workingChat(),
    async () => undefined,
    capabilityStore,
  );
  const { repo } = await appWithProject(client);
  const project = await vi.waitFor(() => {
    const found = real.projects.getSnapshot().projects.find((each) => each.path === repo);
    if (found === undefined) throw new Error("the project is not in the list yet");
    return found;
  });
  await vi.waitFor(() => expect(real.sessions.getSnapshot().loaded).toBe(true));

  const task: Task = {
    id: "task-chat-unknown-capability",
    projectId: project.id,
    title: "Unknown capability",
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
    kind: "codex",
    view: "chat",
    agentSessionId: "codex-seeded",
    terminalId: null,
    state: "running",
    status: null,
    createdAt: 1,
  };
  const codex: ChatDriverCapabilities = {
    kind: "codex",
    steer: true,
    followUp: false,
    approvals: true,
    modelSwitch: false,
    reasoningLevels: false,
    terminalView: "both-live",
  };

  try {
    tasks.set({ loaded: true, tasks: [task] });
    sessions.set({ loaded: true, sessions: [session] });

    await openSeededTask("Unknown capability");
    const composer = page.getByRole("textbox", { name: "Message" });
    // No answer yet: the composer keeps today's offer instead of stripping a mode it cannot see.
    await expect.element(page.getByRole("button", { name: "Queue" })).toBeVisible();

    // The loaded record hides it in place; the chat stays selected and keeps its draft.
    await composer.fill("Keep this while the answer loads");
    capabilities.set({ loaded: true, drivers: [codex] });
    await expect.element(page.getByRole("button", { name: "Queue" })).not.toBeInTheDocument();
    await expect.element(page.getByText(/follow-up/)).not.toBeInTheDocument();
    await expect.element(composer).toHaveValue("Keep this while the answer loads");
  } finally {
    tasks.set({ loaded: true, tasks: [] });
    sessions.set({ loaded: true, sessions: [] });
    chatStore.close();
  }
});

test("the chat model and reasoning controls apply what the driver reports, from the row and the chord", async () => {
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

    await openSeededTask("Chat settings");
    // The row shows what the driver reported, not a client guess.
    await expect.element(page.getByRole("button", { name: "Model Stub One" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Reasoning medium" })).toBeVisible();

    // The row's model control opens the chooser with the driver's own list.
    await page.getByRole("button", { name: "Model Stub One" }).click();
    const modelDialog = page.getByRole("dialog", { name: "Chat model" });
    await expect.element(modelDialog).toBeVisible();
    await expect.element(modelDialog).toMatchTextContent("Stub Two");
    await modelDialog.getByRole("option", { name: /Stub Two/ }).click();
    await vi.waitFor(() =>
      expect(setModel).toHaveBeenCalledExactlyOnceWith({
        sessionId: chatSession,
        model: { provider: "stub", id: "stub-2" },
      }),
    );
    await expect.element(modelDialog).toBeVisible();
    // The old model's levels are gone until the driver reports the new model; the column keeps
    // its geometry with skeleton rows and busy semantics instead of showing the previous levels.
    await expect
      .element(modelDialog.getByRole("group", { name: "Thinking levels" }))
      .toHaveAttribute("aria-busy", "true");
    expect(
      modelDialog.element().querySelectorAll(".model-picker-level-skeleton").length,
    ).toBeGreaterThan(0);
    await expect
      .element(modelDialog.getByRole("toolbar", { name: "Thinking" }))
      .not.toBeInTheDocument();
    expect(modelDialog.element().querySelectorAll("p")).toHaveLength(0);
    await userEvent.keyboard("{Escape}");
    await expect.element(modelDialog).not.toBeInTheDocument();
    await expect.element(page.getByRole("textbox", { name: "Message" })).toHaveFocus();

    // The row's reasoning picker opens the level list; the driver's own values are what it offers.
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
    // Choosing a level keeps the picker open on the chosen level.
    await expect.element(levelDialog).toBeVisible();
    await expect
      .element(levelDialog.getByRole("button", { name: "high", exact: true }))
      .toHaveFocus();
    await userEvent.keyboard("{Escape}");
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

test("a reported model with empty levels keeps the thinking column busy until levels arrive", async () => {
  const state = workingChat({
    model: { provider: "stub", id: "stub-1", name: "Stub One" },
    models: [
      { provider: "stub", id: "stub-1", name: "Stub One" },
      { provider: "stub", id: "stub-2", name: "Stub Two" },
    ],
    reasoning: "medium",
    reasoningLevels: ["off", "medium", "high"],
  });
  const { client, real, tasks, sessions, chatStore, chatState, chatSession } = seededClient(state);
  const { repo } = await appWithProject(client);
  const project = await vi.waitFor(() => {
    const found = real.projects.getSnapshot().projects.find((each) => each.path === repo);
    if (found === undefined) throw new Error("the project is not in the list yet");
    return found;
  });
  await vi.waitFor(() => expect(real.sessions.getSnapshot().loaded).toBe(true));

  const task: Task = {
    id: "task-chat-levels-pending",
    projectId: project.id,
    title: "Levels pending",
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

    await openSeededTask("Levels pending");
    await page.getByRole("button", { name: "Model Stub One" }).click();
    const dialog = page.getByRole("dialog", { name: "Chat model" });
    await dialog.getByRole("option", { name: /Stub Two/ }).click();
    const thinking = dialog.getByRole("group", { name: "Thinking levels" });
    await expect.element(thinking).toHaveAttribute("aria-busy", "true");
    expect(thinking.element().querySelectorAll(".model-picker-level-skeleton").length).toBe(3);

    // The driver reports the new model first and refreshes the levels later: still pending.
    chatState.set({
      loaded: true,
      sequence: 1,
      items: [],
      failure: null,
      state: {
        ...state,
        model: { provider: "stub", id: "stub-2", name: "Stub Two" },
        reasoningLevels: [],
      },
    });
    await expect.element(thinking).toHaveAttribute("aria-busy", "true");
    await expect
      .element(dialog.getByRole("button", { name: "medium", exact: true }))
      .not.toBeInTheDocument();

    chatState.set({
      loaded: true,
      sequence: 2,
      items: [],
      failure: null,
      state: {
        ...state,
        model: { provider: "stub", id: "stub-2", name: "Stub Two" },
        reasoningLevels: ["off", "medium", "high"],
      },
    });
    await expect.element(dialog.getByRole("button", { name: "medium", exact: true })).toBeVisible();
    expect(thinking.element().getAttribute("aria-busy")).toBeNull();
    expect(thinking.element().querySelectorAll(".model-picker-level-skeleton")).toHaveLength(0);
  } finally {
    tasks.set({ loaded: true, tasks: [] });
    sessions.set({ loaded: true, sessions: [] });
    chatStore.close();
  }
});

test("with no reported thinking levels, Thinking opens an empty track without prose", async () => {
  const { client, real, tasks, sessions, chatStore, chatSession } = seededClient(workingChat());
  const { repo } = await appWithProject(client);
  const project = await vi.waitFor(() => {
    const found = real.projects.getSnapshot().projects.find((each) => each.path === repo);
    if (found === undefined) throw new Error("the project is not in the list yet");
    return found;
  });
  await vi.waitFor(() => expect(real.sessions.getSnapshot().loaded).toBe(true));

  const task: Task = {
    id: "task-chat-empty-thinking",
    projectId: project.id,
    title: "Empty thinking",
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

    await openSeededTask("Empty thinking");
    const thinking = page.getByRole("button", { name: "Thinking" });
    await expect.element(thinking).toBeEnabled();
    await expect.element(thinking).toHaveTextContent("Thinking");

    // The pointer gets the same picker as the chord, and its empty track carries no sentence.
    await userEvent.click(thinking);
    const levelDialog = page.getByRole("dialog", { name: "Reasoning level" });
    await expect.element(levelDialog).toBeVisible();
    expect(levelDialog.element().querySelectorAll("p")).toHaveLength(0);
    expect(levelDialog.element().querySelector(".model-picker-levels-empty")).not.toBeNull();
    await userEvent.keyboard("{Escape}");
    await expect.element(levelDialog).not.toBeInTheDocument();

    // `prefix shift+m` opens the same picker with the same empty track.
    await prefixShifted("m");
    await expect.element(levelDialog).toBeVisible();
    expect(levelDialog.element().querySelectorAll("p")).toHaveLength(0);
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

    await openSeededTask("Refused model");
    await page.getByRole("button", { name: "Model Stub One" }).click();
    const dialog = page.getByRole("dialog", { name: "Chat model" });
    await expect.element(dialog).toBeVisible();
    await dialog.getByRole("option", { name: /Stub Two/ }).click();

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
