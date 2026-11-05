import type { ChatStoreSnapshot } from "@corral/client/chat-state";
import type { ChatStore } from "@corral/client/chat-store";
import type { CorralClient } from "@corral/client/corral-client";
import type { SessionsSnapshot } from "@corral/client/sessions-store";
import { Store } from "@corral/client/store";
import type { TasksSnapshot } from "@corral/client/tasks-store";
import type { AgentStatus, Session, SessionView, Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { prefixThen, realServerClients } from "../../../test/real-client.ts";
import { workingChat } from "../../../test/recorded-chat.ts";
import { appWithProject } from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();

/**
 * The selected task's sessions are seeded through the client's own stores, and the two answers the
 * workspace asks for are recorded: `sessions.setView` and the two chat calls. The server's own
 * sessions are untouched, so this file leaves nothing behind on the shared server.
 */
function seededClient(options: {
  drivers: "claude" | "pi" | "opencode";
  turn: "idle" | "working";
  bothLive?: boolean;
}) {
  const real = newClient();
  // `sessions.setView` is recorded and answered by the test, which decides when the server's
  // reply lands: in between, the main area is the handoff notice.
  let release: (() => void) | undefined;
  const setView = vi
    .fn<
      (input: {
        id: string;
        view: SessionView;
        size: { cols: number; rows: number };
      }) => Promise<Session>
    >()
    .mockImplementation(
      (input) =>
        new Promise<Session>((resolve) => {
          const session = sessions.getSnapshot().sessions.find((each) => each.id === input.id)!;
          release = () => resolve({ ...session, view: input.view, terminalId: null });
        }),
    );
  const api = new Proxy(real.connection.api, {
    get(target, property, receiver) {
      if (property === "sessions") {
        const sessionsApi = Reflect.get(target, property, receiver) as object;
        return new Proxy(sessionsApi, {
          get(sessionTarget, sessionProperty, sessionReceiver) {
            if (sessionProperty === "setView") return setView;
            return Reflect.get(sessionTarget, sessionProperty, sessionReceiver);
          },
        });
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const capabilities = {
    loaded: true,
    drivers: [
      {
        kind: options.drivers,
        steer: true,
        followUp: true,
        approvals: true,
        modelSwitch: true,
        reasoningLevels: true,
        terminalView:
          options.bothLive === true ? ("both-live" as const) : ("handoff-only" as const),
      },
    ],
  } as const;
  const tasks = new Store<TasksSnapshot>({ loaded: true, tasks: [] });
  const sessions = new Store<SessionsSnapshot>({ loaded: true, sessions: [] });
  const chatState = new Store<ChatStoreSnapshot>({
    loaded: true,
    sequence: 0,
    state: options.turn === "working" ? workingChat() : { ...workingChat(), turn: "idle" },
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
    connection: { ...real.connection, api },
    // The offer is the server's answer: this file flips it to prove the client does not decide
    // by agent kind on its own (D7). One snapshot object, as a real store holds one.
    chatCapabilities: {
      subscribe: () => () => {},
      getSnapshot: () => capabilities,
      close: () => {},
    },
    openChat: () => chatStore,
  };
  return { client, real, tasks, sessions, setView, chatStore, releaseSetView: () => release?.() };
}

function seededTask(projectId: string, workspacePath: string): Task {
  return {
    id: "task-handoff",
    projectId,
    title: "Handoff",
    titleSource: "user",
    prompt: null,
    primarySessionId: "agent-pi",
    branch: "main",
    workspacePath,
    ownsWorktree: false,
    state: "active",
    seenAt: null,
    createdAt: 1,
  };
}

function seededSession(
  id: string,
  taskId: string,
  kind: "claude" | "pi" | "opencode",
  view: SessionView,
  status: AgentStatus | null = null,
): Session {
  return {
    id,
    taskId,
    kind,
    view,
    agentSessionId: `${kind}-seeded`,
    terminalId: null,
    state: "running",
    status,
    label: null,
    createdAt: 1,
  };
}

const palette = () => page.getByRole("dialog", { name: "Command palette" });
const paletteItem = (name: RegExp) => palette().getByRole("option", { name });

const openSeededTask = (title: string) =>
  page
    .getByRole("navigation", { name: "workspace" })
    .getByRole("button", { name: new RegExp(`^${title}`) })
    .click();

async function openPalette() {
  await prefixThen(" ");
  await userEvent.keyboard("switch view");
}

/**
 * The task and its sessions come from the client stores, and the answer to `chat.capabilities`
 * is the test's: a listener reserves `claude` where the real build reserves `pi`.
 */
test("prefix v is offered by what chat.capabilities says, and the palette says why not", async () => {
  const { client, real, tasks, sessions, setView, chatStore, releaseSetView } = seededClient({
    drivers: "claude",
    turn: "idle",
  });
  const { repo } = await appWithProject(client);
  const project = await vi.waitFor(() => {
    const found = real.projects.getSnapshot().projects.find((each) => each.path === repo);
    if (found === undefined) throw new Error("the project is not in the list yet");
    return found;
  });
  await vi.waitFor(() => expect(real.sessions.getSnapshot().loaded).toBe(true));
  const task = seededTask(project.id, project.path);

  try {
    tasks.set({ loaded: true, tasks: [task] });
    sessions.set({
      loaded: true,
      sessions: [
        seededSession("agent-pi", task.id, "pi", "chat"),
        seededSession("agent-claude", task.id, "claude", "terminal"),
      ],
    });
    // Adding the project left its composer open over the URL's project; choosing the seeded task
    // leaves it for the task the URL does not name.
    await openSeededTask("Handoff");
    await expect.element(page.getByRole("tab", { name: /^pi/ })).toBeVisible();

    // The pi session is selected, and the server's list says only claude has a driver: disabled.
    await openPalette();
    const offered = paletteItem(/Switch view/);
    await expect.element(offered).toHaveAttribute("aria-disabled", "true");
    await expect
      .element(offered)
      .toMatchTextContent("The pi agent has no chat driver in this build.");
    await userEvent.keyboard("{Escape}");

    // Selecting the claude session flips it: the offer is the server's answer, not the agent kind.
    await prefixThen("2");
    await expect
      .element(page.getByRole("tab", { name: /^claude/ }))
      .toHaveAttribute("aria-selected", "true");
    await openPalette();
    await expect
      .element(paletteItem(/Switch to chat/))
      .not.toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(setView).toHaveBeenCalledWith({
        id: "agent-claude",
        view: "chat",
        size: expect.objectContaining({ cols: expect.any(Number) }),
      }),
    );
    // An idle session switches at once: the main area says so until the server has done it.
    await expect
      .element(page.getByRole("status", { name: /Switching this session to chat/ }))
      .toBeVisible();
    releaseSetView();
    await expect
      .element(page.getByRole("status", { name: /Switching this session to chat/ }))
      .not.toBeInTheDocument();
  } finally {
    tasks.set({ loaded: true, tasks: [] });
    sessions.set({ loaded: true, sessions: [] });
    chatStore.close();
    expect(real.sessions.getSnapshot().sessions).toEqual([]);
  }
});

test("a busy agent is asked before prefix v switches, and the confirmation says what is lost", async () => {
  const { client, real, tasks, sessions, setView, chatStore, releaseSetView } = seededClient({
    drivers: "pi",
    turn: "working",
  });
  const { repo } = await appWithProject(client);
  const project = await vi.waitFor(() => {
    const found = real.projects.getSnapshot().projects.find((each) => each.path === repo);
    if (found === undefined) throw new Error("the project is not in the list yet");
    return found;
  });
  await vi.waitFor(() => expect(real.sessions.getSnapshot().loaded).toBe(true));
  const task = seededTask(project.id, project.path);

  try {
    tasks.set({ loaded: true, tasks: [task] });
    sessions.set({ loaded: true, sessions: [seededSession("agent-pi", task.id, "pi", "chat")] });
    await openSeededTask("Handoff");
    await expect.element(page.getByRole("log", { name: "Chat transcript" })).toBeVisible();

    // While the turn is working, `prefix v` asks first: the turn is aborted and nothing else.
    await prefixThen("v");
    const confirm = page.getByRole("alertdialog");
    await expect.element(confirm).toBeVisible();
    await expect
      .element(confirm)
      .toMatchTextContent("The agent is working. Switching aborts the turn first.");
    await expect.element(confirm.getByRole("button", { name: "Cancel" })).toHaveFocus();
    expect(setView).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await expect.element(confirm).not.toBeInTheDocument();
    expect(setView).not.toHaveBeenCalled();

    // Confirming runs the handoff on the same session, and the main area steps aside meanwhile.
    await prefixThen("v");
    await expect.element(confirm).toBeVisible();
    await userEvent.keyboard("{Tab}{Enter}");
    await vi.waitFor(() =>
      expect(setView).toHaveBeenCalledWith({
        id: "agent-pi",
        view: "terminal",
        size: expect.objectContaining({ rows: expect.any(Number) }),
      }),
    );
    // The dialog stays while the server works, with its button held: no second switch.
    await expect
      .element(confirm.getByRole("button", { name: "Switch to terminal" }))
      .toBeDisabled();
    releaseSetView();
    await expect.element(confirm).not.toBeInTheDocument();
  } finally {
    tasks.set({ loaded: true, tasks: [] });
    sessions.set({ loaded: true, sessions: [] });
    chatStore.close();
    expect(real.sessions.getSnapshot().sessions).toEqual([]);
  }
});

test("a both-live agent opens the other view beside the running one: no handoff, no confirmation", async () => {
  const { client, real, tasks, sessions, setView, chatStore, releaseSetView } = seededClient({
    drivers: "opencode",
    bothLive: true,
    turn: "working",
  });
  const { repo } = await appWithProject(client);
  const project = await vi.waitFor(() => {
    const found = real.projects.getSnapshot().projects.find((each) => each.path === repo);
    if (found === undefined) throw new Error("the project is not in the list yet");
    return found;
  });
  await vi.waitFor(() => expect(real.sessions.getSnapshot().loaded).toBe(true));
  const task = seededTask(project.id, project.path);

  try {
    tasks.set({ loaded: true, tasks: [task] });
    sessions.set({
      loaded: true,
      sessions: [seededSession("agent-oc", task.id, "opencode", "chat")],
    });
    await openSeededTask("Handoff");
    await expect.element(page.getByRole("log", { name: "Chat transcript" })).toBeVisible();

    const composer = page.getByRole("textbox", { name: "Message" });
    await composer.fill("Unsent through a view handoff");

    // The palette says what the action does for this driver: it opens, it does not switch.
    await openPalette();
    await expect
      .element(paletteItem(/Open the terminal view/))
      .not.toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Escape}");

    // The turn is working, and still nothing is asked: opening the terminal adds a client of the
    // agent's server, so the turn is not aborted and no request is cancelled.
    await prefixThen("v");
    await vi.waitFor(() =>
      expect(setView).toHaveBeenCalledWith({
        id: "agent-oc",
        view: "terminal",
        size: expect.objectContaining({ cols: expect.any(Number) }),
      }),
    );
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("status", { name: /Opening the terminal view/ }))
      .toBeVisible();
    releaseSetView();
    await expect
      .element(page.getByRole("status", { name: /Opening the terminal view/ }))
      .not.toBeInTheDocument();
    await expect.element(composer).toHaveValue("Unsent through a view handoff");
  } finally {
    tasks.set({ loaded: true, tasks: [] });
    sessions.set({ loaded: true, sessions: [] });
    chatStore.close();
    expect(real.sessions.getSnapshot().sessions).toEqual([]);
  }
});

test("a busy terminal says its turn is cut, not aborted, because it has no abort channel", async () => {
  const { client, real, tasks, sessions, setView, chatStore } = seededClient({
    drivers: "claude",
    turn: "idle",
  });
  const { repo } = await appWithProject(client);
  const project = await vi.waitFor(() => {
    const found = real.projects.getSnapshot().projects.find((each) => each.path === repo);
    if (found === undefined) throw new Error("the project is not in the list yet");
    return found;
  });
  await vi.waitFor(() => expect(real.sessions.getSnapshot().loaded).toBe(true));
  const task = seededTask(project.id, project.path);

  try {
    tasks.set({ loaded: true, tasks: [task] });
    sessions.set({
      loaded: true,
      sessions: [
        seededSession("agent-claude", task.id, "claude", "terminal", {
          state: "working",
          updatedAt: 1,
        }),
      ],
    });
    await openSeededTask("Handoff");
    await expect.element(page.getByRole("tab", { name: /^claude/ })).toBeVisible();

    // A terminal's status is what the server hears from the agent; a working one asks first, but
    // the wording must not promise an abort this direction does not have (the PTY is closed).
    await prefixThen("v");
    const confirm = page.getByRole("alertdialog");
    await expect.element(confirm).toBeVisible();
    await expect
      .element(confirm)
      .toMatchTextContent(
        "The agent is working. Switching closes its terminal first; what it has not written is lost.",
      );
    expect(setView).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await expect.element(confirm).not.toBeInTheDocument();

    // A terminal that is *blocked* waits for an answer: the request dies with the PTY, and the
    // confirmation says that instead of "cancels that request with the frontend".
    sessions.set({
      loaded: true,
      sessions: [
        seededSession("agent-claude", task.id, "claude", "terminal", {
          state: "blocked",
          kind: "question",
          message: "Run the migration?",
          updatedAt: 1,
        }),
      ],
    });
    await prefixThen("v");
    await expect.element(confirm).toBeVisible();
    await expect
      .element(confirm)
      .toMatchTextContent(
        "The agent is waiting for your answer. Switching closes its terminal and the request is lost.",
      );
    expect(setView).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    await expect.element(confirm).not.toBeInTheDocument();
  } finally {
    tasks.set({ loaded: true, tasks: [] });
    sessions.set({ loaded: true, sessions: [] });
    chatStore.close();
    expect(real.sessions.getSnapshot().sessions).toEqual([]);
  }
});
