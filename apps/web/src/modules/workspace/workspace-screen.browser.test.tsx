import type { CorralClient } from "@corral/client/corral-client";
import type { ProjectsSnapshot } from "@corral/client/projects-store";
import type { SessionsSnapshot } from "@corral/client/sessions-store";
import { Store } from "@corral/client/store";
import type { TasksSnapshot } from "@corral/client/tasks-store";
import type { TerminalsSnapshot } from "@corral/client/terminals-store";
import type { TerminalSurface } from "@corral/client/terminal-stream";
import type { WatchFailure, WatchStore } from "@corral/client/watch-store";
import { PROTOCOL_VERSION } from "@corral/protocol/handshake";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import {
  prefixShifted,
  prefixThen,
  screenText,
  realServerClients,
} from "../../../test/real-client.ts";
import { writeConfig } from "../../../test/config-command.ts";
import { serverTarget } from "../../../test/server-url.ts";
import { App, renderApp } from "../../../test/render-app.tsx";
import { createGitRepo } from "../../../test/git-repo.ts";
import {
  openAgentSessionPicker,
  appWithProject,
  createTask,
  createTaskWithShell,
  promptField,
  sessionTab,
  shellTabs,
  startShell,
  taskButton,
  taskHeader,
  newTaskView,
} from "../../../test/task-flows.tsx";

const claimNextProtocolVersion: (url: string, protocols: string[]) => WebSocket = (
  url,
  protocols,
) =>
  new WebSocket(
    url.replace(`protocol=${PROTOCOL_VERSION}`, `protocol=${PROTOCOL_VERSION + 1}`),
    protocols,
  );

const claimOldProtocolVersion: (url: string, protocols: string[]) => WebSocket = (url, protocols) =>
  new WebSocket(url.replace(`protocol=${PROTOCOL_VERSION}`, "protocol=4"), protocols);

const SIZE = { cols: 80, rows: 24 };
const { newClient } = realServerClients();

interface FakeWatch<Snapshot> {
  store: WatchStore<Snapshot>;
  set(value: Snapshot): void;
  fail(failure: WatchFailure | undefined): void;
  retries(): number;
}

/** A watched list whose snapshots and refusal the test decides, with a real Retry entry point. */
function fakeWatch<Snapshot>(initial: Snapshot, recover?: Snapshot): FakeWatch<Snapshot> {
  const snapshot = new Store(initial);
  const failure = new Store<WatchFailure | undefined>(undefined);
  let retries = 0;
  return {
    store: {
      subscribe: snapshot.subscribe,
      getSnapshot: snapshot.getSnapshot,
      failure: { subscribe: failure.subscribe, getSnapshot: failure.getSnapshot },
      retry: () => {
        retries += 1;
        if (recover === undefined) return;
        failure.set(undefined);
        snapshot.set(recover);
      },
      close: () => {},
    },
    set: (value) => snapshot.set(value),
    fail: (value) => failure.set(value),
    retries: () => retries,
  };
}

/** The real server's connection and the test's four watched lists. */
function fakeLists(
  real: CorralClient,
  lists: {
    projects: FakeWatch<ProjectsSnapshot>;
    tasks: FakeWatch<TasksSnapshot>;
    sessions: FakeWatch<SessionsSnapshot>;
    terminals: FakeWatch<TerminalsSnapshot>;
  },
): CorralClient {
  return {
    ...real,
    projects: lists.projects.store,
    tasks: lists.tasks.store,
    sessions: lists.sessions.store,
    terminals: lists.terminals.store,
  };
}

test("the prefix chord arms prefix mode and the next key disarms it", async () => {
  await render(<App client={newClient()} />);
  const indicator = page.getByRole("status", { name: "prefix mode" });

  await userEvent.keyboard("{Alt>}a{/Alt}");
  await expect.element(indicator).toBeVisible();

  await userEvent.keyboard("q");
  await expect.element(indicator).not.toBeInTheDocument();
});

test("the same key without the prefix's modifier does not arm prefix mode", async () => {
  await render(<App client={newClient()} />);
  await userEvent.keyboard("a");
  await expect.element(page.getByRole("status", { name: "prefix mode" })).not.toBeInTheDocument();
});

const workspace = () => page.getByRole("navigation", { name: "workspace" });
const hiddenWorkspace = () =>
  page.getByRole("navigation", { name: "workspace", includeHidden: true });
const board = () => page.getByRole("region", { name: "Board" });
const boardList = () => board().getByRole("listbox");
const boardBack = () => board().getByRole("button", { name: "Back to workspace" });
// Terminals of the test server run /bin/sh, which the sidebar labels "sh · <folder>".
const terminalButtons = () => workspace().getByRole("button", { name: /^sh · / });
const hiddenTerminalButtons = () =>
  hiddenWorkspace().getByRole("button", { name: /^sh · /, includeHidden: true });
const selectButton = (index: number) => terminalButtons().nth(index);

const idleSurface: TerminalSurface = {
  write: () => undefined,
  reset: () => undefined,
  resize: () => undefined,
};

/** Sends input to a live terminal from a second attachment, without touching its keyboard. */
async function writeTerminal(client: CorralClient, terminalId: string, text: string) {
  const stream = client.attach(terminalId, idleSurface);
  await vi.waitFor(() => expect(stream.state.getSnapshot().status).toBe("connected"));
  stream.input(text);
  return stream;
}

interface SeededBoard {
  client: CorralClient;
  projectId: string;
  taskId: string;
  sessionId: string;
  terminalId: string;
  workspaceHref: string;
  boardHref: string;
}

/** A project with two active tasks and a live shell, plus the URLs that select one of them. */
async function seedBoard(): Promise<SeededBoard> {
  const client = newClient();
  await expect.poll(() => client.connection.state.getSnapshot().status).toBe("connected");
  const { api } = client.connection;
  const project = await api.projects.add({ path: await createGitRepo("board-focus") });
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Board focus",
    workspace: { type: "main-worktree" },
  });
  await api.tasks.create({
    projectId: project.id,
    title: "Board second",
    workspace: { type: "main-worktree" },
  });
  const session = await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });
  const search = `project=${project.id}&task=${task.id}&entry=${session.id}`;
  return {
    client,
    projectId: project.id,
    taskId: task.id,
    sessionId: session.id,
    terminalId: session.terminalId!,
    workspaceHref: `/?${search}`,
    boardHref: `/board?${search}`,
  };
}

test("prefix then c opens a terminal that takes the keyboard straight away", async () => {
  await render(<App client={newClient()} />);
  await expect.element(page.getByText("Add a repository to start")).toBeVisible();

  await prefixThen("c");
  await expect.element(terminalButtons()).toHaveLength(1);
  await expect.element(selectButton(0)).toHaveAttribute("aria-current", "true");

  await userEvent.keyboard("echo it-is-$((6*7)){Enter}");
  await expect.poll(screenText).toContain("it-is-42");
});

test("the selected terminal survives a reload through the search params", async () => {
  const client = newClient();
  const first = await renderApp(client);
  await prefixThen("c");
  await expect.element(terminalButtons()).toHaveLength(1);
  await vi.waitFor(() => expect(first.history.location.search).toContain("entry="));
  const href = `${first.history.location.pathname}${first.history.location.search}`;
  await first.unmount();

  await renderApp(client, [href]);

  await expect.element(terminalButtons()).toHaveLength(1);
  await expect.element(selectButton(0)).toHaveAttribute("aria-current", "true");
});

test("the prefix and its action key are not typed into the terminal", async () => {
  await render(<App client={newClient()} />);
  await prefixThen("c");
  await expect.element(terminalButtons()).toHaveLength(1);

  // Only one terminal, so p changes nothing; if it leaked, sh would report "p: not found".
  await prefixThen("p");
  await userEvent.keyboard("echo marker-$((1+1)){Enter}");

  await expect.poll(screenText).toContain("marker-2");
  expect(screenText()).not.toContain("not found");
});

test("prefix n and p switch between terminals, wrapping around", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await prefixThen("c");
  await prefixThen("c");
  await expect.element(terminalButtons()).toHaveLength(2);
  await expect.element(selectButton(1)).toHaveAttribute("aria-current", "true");

  await prefixThen("n");
  await expect.element(selectButton(0)).toHaveAttribute("aria-current", "true");
  await prefixThen("p");
  await expect.element(selectButton(1)).toHaveAttribute("aria-current", "true");
  await prefixThen("n");
  await expect.element(selectButton(0)).toHaveAttribute("aria-current", "true");

  await userEvent.keyboard("echo first-$((2*3)){Enter}");
  await expect.poll(screenText).toContain("first-6");
});

test("prefix x closes the active terminal and the neighbour takes over", async () => {
  await render(<App client={newClient()} />);
  await prefixThen("c");
  await prefixThen("c");
  await expect.element(terminalButtons()).toHaveLength(2);

  await prefixThen("x");
  await expect.element(terminalButtons()).toHaveLength(1);
  await expect.element(selectButton(0)).toHaveAttribute("aria-current", "true");

  await prefixThen("x");
  await expect.element(page.getByText("Add a repository to start")).toBeVisible();
});

test("clicking a terminal in the list shows it and keeps typing going to the terminal", async () => {
  await render(<App client={newClient()} />);
  await prefixThen("c");
  await prefixThen("c");
  await expect.element(terminalButtons()).toHaveLength(2);

  await selectButton(0).click();
  await expect.element(selectButton(0)).toHaveAttribute("aria-current", "true");
  await userEvent.keyboard("echo clicked-$((5+5)){Enter}");

  await expect.poll(screenText).toContain("clicked-10");
});

test("a terminal whose process ended stays listed as exited until it is closed", async () => {
  const client = newClient();
  await expect.poll(() => client.connection.state.getSnapshot().status).toBe("connected");
  await client.connection.api.terminals.create({
    command: "/bin/sh",
    args: ["-c", "echo bye; exit 3"],
    size: SIZE,
  });
  await render(<App client={client} />);

  await expect.element(page.getByText("exited (3)")).toBeVisible();
  await expect.element(page.getByRole("status", { name: "terminal exited" })).toBeVisible();
  await expect.poll(screenText).toContain("bye");

  await prefixThen("x");
  await expect.element(page.getByText("Add a repository to start")).toBeVisible();
});

test("a server on another protocol version gets a clear message instead of the workspace", async () => {
  await render(<App client={newClient(serverTarget(), claimNextProtocolVersion)} />);

  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect
    .element(page.getByText(new RegExp(`The server speaks protocol version ${PROTOCOL_VERSION};`)))
    .toBeVisible();
  await expect.element(workspace()).not.toBeInTheDocument();
});

test("an old protocol 4 server is refused before the keymap or any mutation", async () => {
  await render(<App client={newClient(serverTarget(), claimOldProtocolVersion)} />);

  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect
    .element(page.getByText(new RegExp(`The server speaks protocol version ${PROTOCOL_VERSION};`)))
    .toBeVisible();
  await expect.element(workspace()).not.toBeInTheDocument();
  await prefixThen("c");
  await expect.element(page.getByRole("status", { name: "prefix mode" })).not.toBeInTheDocument();
  await expect.element(terminalButtons()).toHaveLength(0);
});

test("an unreachable server at startup shows the framed notice, not an empty workspace", async () => {
  await render(
    <App
      client={newClient({ url: "ws://127.0.0.1:1", capability: "unreachable" }, undefined, {
        backoff: { initialMs: 60_000, maxMs: 60_000 },
      })}
    />,
  );

  await expect
    .element(page.getByRole("heading", { name: "Cannot reach the server" }))
    .toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "Capability" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Retry now" })).toBeVisible();
  await expect.element(workspace()).not.toBeInTheDocument();
});

/** A client whose sockets the test can drop, so the workspace stays loaded over a dead server. */
function droppableClient() {
  const sockets: WebSocket[] = [];
  const client = newClient(
    serverTarget(),
    (url, protocols) => {
      const socket = new WebSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
    { backoff: { initialMs: 60_000, maxMs: 60_000 } },
  );
  return {
    client,
    drop: () => {
      for (const socket of sockets.splice(0)) {
        socket.dispatchEvent(new CloseEvent("close", { code: 1006 }));
        // `close(1006)` is rejected by the platform: 1006 is reserved for a close the browser
        // observed, so the test dispatches that event and closes the socket with the normal code.
        socket.close();
      }
    },
  };
}

/**
 * A loaded workspace whose connection just dropped. The framed boot notice only covers a first
 * attempt, so an established tab shows the status surface instead.
 */
async function droppedWorkspace() {
  const { client, drop } = droppableClient();
  await appWithProject(client);
  await expect.poll(() => client.connection.state.getSnapshot().status).toBe("connected");
  drop();
  await expect.poll(() => client.connection.state.getSnapshot().status).toBe("disconnected");
  return client;
}

const connectionOpener = () => page.getByRole("button", { name: /^connection:/ });

/** The surface a status fact is rendered in: A4's two placements, told apart for the test. */
function statusSurface(placement: "footer" | "strip") {
  const surface = connectionOpener()
    .element()
    .closest<HTMLElement>(`[data-slot="shell-status"][data-placement="${placement}"]`);
  if (surface === null) throw new Error(`the status is not in the ${placement} placement`);
  return surface;
}

test("the footer status opens the recovery dialog, keeps its guidance, and returns focus", async () => {
  await droppedWorkspace();

  const opener = connectionOpener();
  await expect.element(opener).toBeVisible();
  await expect.element(opener).toMatchTextContent(/Cannot reach the server/);
  statusSurface("footer");

  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Cannot reach the server" });
  await expect.element(dialog).toBeVisible();
  // A2's guidance survives the merge: the rotated capability's sentence and the field it names.
  await expect
    .element(
      dialog.getByText(
        /If the server restarted, paste the capability it published in endpoint\.json/,
      ),
    )
    .toBeVisible();
  await expect.element(dialog.getByRole("textbox", { name: "Capability" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(opener).toHaveFocus();
});

test("the hidden strip keeps the connection status and returns focus to it", async () => {
  await droppedWorkspace();
  await expect.element(connectionOpener()).toBeVisible();

  await prefixThen("\\");
  await expect.element(workspace()).not.toBeInTheDocument();
  statusSurface("strip");
  await expect.element(connectionOpener()).toBeVisible();

  const opener = connectionOpener();
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Cannot reach the server" });
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog.getByText(/endpoint\.json/)).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(opener).toHaveFocus();
});

test("the hidden strip does not take the terminal's keyboard", async () => {
  const { client, drop } = droppableClient();
  await appWithProject(client);
  await createTaskWithShell("Keeps its keyboard");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  drop();
  await expect.poll(() => client.connection.state.getSnapshot().status).toBe("disconnected");

  await prefixThen("\\");
  await expect.element(workspace()).not.toBeInTheDocument();
  statusSurface("strip");
  expect(focusedIsTerminal()).toBe(true);
});

test("config problems keep their icon and dialog with the sidebar hidden", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await writeConfig('[keys.bindings]\nnew-agent = "hyper+q"\n');
  await vi.waitFor(() => expect(client.config.getSnapshot().problems).toHaveLength(1));

  await prefixThen("\\");
  await expect.element(workspace()).not.toBeInTheDocument();

  const notice = page.getByRole("button", { name: "config: 1 problem" });
  await expect.element(notice).toBeVisible();
  await notice.click();
  const dialog = page.getByRole("dialog", { name: "Config problems" });
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog).toMatchTextContent("keys.bindings.new-agent");
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
});

test("a guidance failure can be dismissed", async () => {
  await appWithProject(newClient());
  const notice = page.getByRole("status").filter({ hasText: "Select a task to see its changes." });

  await prefixShifted("c");
  await expect.element(notice).toBeVisible();

  const dismiss = page.getByRole("button", { name: "Dismiss status" });
  await expect.element(dismiss).toBeVisible();
  expect(dismiss.element().previousElementSibling?.textContent).toBe(
    "Select a task to see its changes.",
  );
  await dismiss.click();
  await expect.element(notice).not.toBeInTheDocument();
});

test("a status failure clears when the navigation it asked for arrives", async () => {
  await appWithProject(newClient());
  const notice = page.getByText("Select a task to see its changes.");

  await prefixShifted("c");
  await expect.element(notice).toBeVisible();
  await createTask("Has a task");
  await expect.element(notice).not.toBeInTheDocument();
});

test("a failed action is the kit's alert, not a quiet notice", async () => {
  await droppedWorkspace();
  await prefixThen("c");

  const failure = page
    .getByRole("alert")
    .filter({ hasText: "The server is not connected, so the action was not sent." });
  await expect.element(failure).toBeVisible();
  await expect.element(failure).toHaveAttribute("data-slot", "alert");
  await expect
    .element(page.getByText("not connected to the server", { exact: true }))
    .not.toBeInTheDocument();
});

test("a failed action keeps its message and the terminal's focus until the next selection", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Stays");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await prefixThen("g");
  const notice = page.getByText("No blocked sessions.");
  await expect.element(notice).toBeVisible();
  expect(focusedIsTerminal()).toBe(true);

  await taskButton("Stays").click();
  await expect.element(notice).not.toBeInTheDocument();
});

test("the status row stays one line at 1024 at both sidebar widths, at 140% too", async () => {
  await droppedWorkspace();
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  const surface = statusSurface("footer");
  const row = surface.lastElementChild as HTMLElement;
  /** One line, no document overflow, and the row's hint or badge plus the opener inside the pane. */
  const assertRowFits = (contents: "hint" | "badge") => {
    expect(row.clientHeight).toBeGreaterThan(0);
    expect(row.scrollHeight).toBeLessThanOrEqual(row.clientHeight + 1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(window.innerHeight);
    const asideRect = handle.element().parentElement!.getBoundingClientRect();
    const contentsRect =
      contents === "hint"
        ? page.getByText("alt+a").element().getBoundingClientRect()
        : page.getByRole("status", { name: "prefix mode" }).element().getBoundingClientRect();
    expect(contentsRect.left).toBeGreaterThanOrEqual(asideRect.left - 1);
    expect(contentsRect.right).toBeLessThanOrEqual(asideRect.right + 1);
    // The contents stay inside the one row rather than being clipped by its fixed height.
    const rowRect = row.getBoundingClientRect();
    expect(contentsRect.top).toBeGreaterThanOrEqual(rowRect.top - 1);
    expect(contentsRect.bottom).toBeLessThanOrEqual(rowRect.bottom + 1);
    expect(connectionOpener().element().getBoundingClientRect().right).toBeLessThanOrEqual(
      asideRect.right + 1,
    );
  };
  const withInterfaceScale = async (read: () => void) => {
    const previous = document.documentElement.style.fontSize;
    document.documentElement.style.fontSize = "140%";
    try {
      // The chrome row reads the interface scale, so the guard is the row's own height, not 36 px.
      await vi.waitFor(() => expect(row.clientHeight).toBeGreaterThan(36));
      read();
    } finally {
      document.documentElement.style.fontSize = previous;
    }
  };

  // The device default at 1024: the narrowest footer the app shows.
  await expect.element(handle).toHaveAttribute("aria-valuenow", "232");
  assertRowFits("hint");
  await withInterfaceScale(() => assertRowFits("hint"));

  handle.element().focus();
  await userEvent.keyboard("{ArrowRight}".repeat(20));
  await expect.element(handle).toHaveAttribute("aria-valuenow", "384");
  assertRowFits("hint");
  await withInterfaceScale(() => assertRowFits("hint"));

  // Arming replaces the hint with the badge inside the same row; the row keeps its height.
  const height = row.clientHeight;
  await userEvent.keyboard("{Alt>}a{/Alt}");
  await expect.element(page.getByRole("status", { name: "prefix mode" })).toBeVisible();
  await expect.element(page.getByText("alt+a")).not.toBeInTheDocument();
  expect(row.clientHeight).toBe(height);
  assertRowFits("badge");
  await withInterfaceScale(() => assertRowFits("badge"));
  expect(row.clientHeight).toBe(height);
  assertRowFits("badge");
});

test("only the placement that is visible is mounted", async () => {
  await droppedWorkspace();
  statusSurface("footer");
  expect(document.querySelectorAll('[data-slot="shell-status"]')).toHaveLength(1);

  await prefixThen("\\");
  await expect.element(workspace()).not.toBeInTheDocument();
  statusSurface("strip");
  // One surface means one live region and one connection opener, not a hidden duplicate.
  expect(document.querySelectorAll('[data-slot="shell-status"]')).toHaveLength(1);
  expect(document.querySelectorAll('[data-slot="shell-status"] [role="status"]')).toHaveLength(1);
  expect(document.querySelectorAll('[aria-label^="connection:"]')).toHaveLength(1);
});

/** Waits for two frames and a fit round-trip, so a resize the arm caused would have landed. */
async function settleLayout() {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 100)));
  });
}

test("arming the prefix never resizes the terminal", async () => {
  const { client } = await appWithProject(newClient());
  await createTaskWithShell("Keeps its height");
  const pane = page.getByRole("region", { name: "active terminal" });
  const host = () => {
    const element = pane.element().querySelector<HTMLElement>(".terminal-host");
    if (element === null) throw new Error("the terminal has no host");
    return element;
  };
  const ptySize = async () => (await client.connection.api.terminals.list())[0]!.size;
  /** The size once it stops moving: a PTY that is still fitting must not be the baseline. */
  const settledSize = async () => {
    let previous = await ptySize();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await settleLayout();
      const next = await ptySize();
      if (JSON.stringify(next) === JSON.stringify(previous)) return next;
      previous = next;
    }
    return previous;
  };
  const measure = async () => {
    const size = await settledSize();
    return { height: host().getBoundingClientRect().height, size };
  };
  const armed = page.getByRole("status", { name: "prefix mode" });

  // Sidebar shown: the badge replaces the footer's hint in the same row.
  const shown = await measure();
  await userEvent.keyboard("{Alt>}a{/Alt}");
  await expect.element(armed).toBeVisible();
  expect(await measure()).toEqual(shown);
  await userEvent.keyboard("q");
  await expect.element(armed).not.toBeInTheDocument();
  expect(await measure()).toEqual(shown);

  // Sidebar hidden: the strip keeps its row whether or not the badge is in it.
  await prefixThen("\\");
  await expect.element(workspace()).not.toBeInTheDocument();
  const hidden = await measure();
  expect(hidden.height).toBeLessThan(shown.height);
  await userEvent.keyboard("{Alt>}a{/Alt}");
  await expect.element(armed).toBeVisible();
  expect(await measure()).toEqual(hidden);
  await userEvent.keyboard("q");
  await expect.element(armed).not.toBeInTheDocument();
  expect(await measure()).toEqual(hidden);
});

const focusedIsTerminal = () => document.activeElement?.classList.contains("xterm-helper-textarea");

test("the main area names the wait until all four lists have delivered", async () => {
  const projects = fakeWatch<ProjectsSnapshot>({ loaded: false, projects: [] });
  const tasks = fakeWatch<TasksSnapshot>({ loaded: false, tasks: [] });
  const sessions = fakeWatch<SessionsSnapshot>({ loaded: false, sessions: [] });
  const terminals = fakeWatch<TerminalsSnapshot>({ loaded: false, terminals: [] });
  await render(<App client={fakeLists(newClient(), { projects, tasks, sessions, terminals })} />);

  const loading = page.getByRole("status", { name: "Loading the workspace" });
  await expect.element(loading).toHaveTextContent("Loading the workspace…");
  await expect.element(page.getByText("Add a repository to start")).not.toBeInTheDocument();

  // Each of the four gates the first-run form on its own.
  projects.set({ loaded: true, projects: [] });
  tasks.set({ loaded: true, tasks: [] });
  sessions.set({ loaded: true, sessions: [] });
  await expect.element(loading).toBeVisible();
  await expect.element(page.getByText("Add a repository to start")).not.toBeInTheDocument();

  terminals.set({ loaded: true, terminals: [] });
  await expect.element(page.getByText("Add a repository to start")).toBeVisible();
  await expect.element(loading).not.toBeInTheDocument();
});

test("prefix t during the wait opens the composer when the project list arrives", async () => {
  const real = newClient();
  await vi.waitFor(() => expect(real.connection.state.getSnapshot().status).toBe("connected"));
  const project = await real.connection.api.projects.add({ path: await createGitRepo("waiting") });
  const projects = fakeWatch<ProjectsSnapshot>({ loaded: false, projects: [] });
  const tasks = fakeWatch<TasksSnapshot>({ loaded: true, tasks: [] });
  const sessions = fakeWatch<SessionsSnapshot>({ loaded: true, sessions: [] });
  const terminals = fakeWatch<TerminalsSnapshot>({ loaded: true, terminals: [] });
  await render(<App client={fakeLists(real, { projects, tasks, sessions, terminals })} />);

  await prefixThen("t");
  await expect.element(page.getByRole("status", { name: "Loading the workspace" })).toBeVisible();

  projects.set({ loaded: true, projects: [project] });
  await expect.element(newTaskView()).toBeVisible();
  await expect.element(promptField()).toHaveFocus();
});

test("a refused list is one muted line with a real Retry, never the first-run form", async () => {
  const projects = fakeWatch<ProjectsSnapshot>(
    { loaded: false, projects: [] },
    { loaded: true, projects: [] },
  );
  projects.fail({
    name: "projects.watch",
    label: "project list",
    error: new Error("no such procedure"),
  });
  const tasks = fakeWatch<TasksSnapshot>({ loaded: true, tasks: [] });
  const sessions = fakeWatch<SessionsSnapshot>({ loaded: true, sessions: [] });
  const terminals = fakeWatch<TerminalsSnapshot>({ loaded: true, terminals: [] });
  await render(<App client={fakeLists(newClient(), { projects, tasks, sessions, terminals })} />);

  await expect.element(page.getByText("The server refused the project list.")).toBeVisible();
  await expect.element(page.getByText("Add a repository to start")).not.toBeInTheDocument();

  await page.getByRole("button", { name: "Retry" }).click();
  expect(projects.retries()).toBe(1);
  await expect.element(page.getByText("Add a repository to start")).toBeVisible();
  await expect
    .element(page.getByText("The server refused the project list."))
    .not.toBeInTheDocument();
});

test("prefix shift+p opens the add-project dialog, where the prefix and its keys are inert", async () => {
  await render(<App client={newClient()} />);
  await prefixThen("c");
  await expect.element(terminalButtons()).toHaveLength(1);

  await prefixShifted("p");
  const dialog = page.getByRole("dialog", { name: "Add project" });
  await expect.element(dialog).toBeVisible();
  const input = dialog.getByRole("textbox", { name: "Repository path" });
  await expect.element(input).toHaveFocus();

  // Inside the dialog the prefix chord arms nothing, so c would not open a second terminal.
  await userEvent.keyboard("{Alt>}a{/Alt}c");
  await expect.element(page.getByRole("status", { name: "prefix mode" })).not.toBeInTheDocument();
  await userEvent.keyboard("x/repo");
  await expect.element(input).toHaveValue("cx/repo");

  // The dialog hides the page from role queries; once it is closed the terminal count shows c did nothing.
  await userEvent.keyboard("{Escape}");
  await expect.element(terminalButtons()).toHaveLength(1);
});

test("Escape closes a dialog and returns the keyboard to the terminal", async () => {
  await render(<App client={newClient()} />);
  await prefixThen("c");
  await expect.element(terminalButtons()).toHaveLength(1);
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await prefixShifted("p");
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await userEvent.keyboard("{Escape}");

  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await userEvent.keyboard("echo back-$((4+4)){Enter}");
  await expect.poll(screenText).toContain("back-8");
});

test("the first character typed after Escape reaches the terminal", async () => {
  await render(<App client={newClient()} />);
  await prefixThen("c");
  await expect.element(terminalButtons()).toHaveLength(1);
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await prefixShifted("p");
  await expect.element(page.getByRole("dialog", { name: "Add project" })).toBeVisible();

  // One keyboard call: Escape closes the dialog and the next character is already the
  // terminal's. The dialog is not awaited out of the document in between.
  await userEvent.keyboard("{Escape}echo first-$((2+2)){Enter}");
  await expect.poll(screenText).toContain("first-4");
  expect(screenText()).not.toContain("not found");
});

test("prefix t without a project says so, and adding the project clears it", async () => {
  await render(<App client={newClient()} />);
  await expect.element(page.getByText("Add a repository to start")).toBeVisible();

  await prefixThen("t");
  const notice = page.getByText(/Add a project first/);
  await expect.element(notice).toBeVisible();
  await expect.element(page.getByRole("form", { name: "New task" })).not.toBeInTheDocument();

  // The failure asked for this add, so completing it spends the message.
  await userEvent.type(
    page.getByRole("textbox", { name: "Repository path" }),
    await createGitRepo("after-prefix-t"),
  );
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect.element(notice).not.toBeInTheDocument();
});

test("prefix b opens the board, which pauses the prefix and closes on Escape", async () => {
  await render(<App client={newClient()} />);
  await prefixThen("c");
  await expect.element(terminalButtons()).toHaveLength(1);

  await prefixThen("b");
  await expect.element(page.getByRole("region", { name: "Board" })).toBeVisible();
  await expect.element(boardBack()).toHaveFocus();
  // The workspace keeps its state but not its keymap while the layer is open.
  await prefixThen("c");
  await expect.element(hiddenTerminalButtons()).toHaveLength(1);
  await userEvent.keyboard("{Escape}");

  await expect.element(page.getByRole("region", { name: "Board" })).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  // The next chord is live again: the sidebar action runs and does not reach the terminal.
  await prefixThen("\\");
  await expect.element(workspace()).not.toBeInTheDocument();
  await prefixThen("\\");
  await expect.element(workspace()).toBeVisible();
});

test("Escape on the board returns to the workspace with the previous selection", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await prefixThen("c");
  await prefixThen("c");
  await expect.element(terminalButtons()).toHaveLength(2);
  await selectButton(0).click();
  await expect.element(selectButton(0)).toHaveAttribute("aria-current", "true");
  const pane = page.getByRole("region", { name: "active terminal" }).element();

  await prefixThen("b");
  await expect.element(page.getByRole("region", { name: "Board" })).toBeVisible();
  await expect.element(boardBack()).toHaveFocus();
  await userEvent.keyboard("{Escape}");

  await expect.element(page.getByRole("region", { name: "Board" })).not.toBeInTheDocument();
  await expect.element(selectButton(0)).toHaveAttribute("aria-current", "true");
  expect(page.getByRole("region", { name: "active terminal" }).element()).toBe(pane);
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
});

test("the board leaves the terminal attached and its grid unchanged underneath", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await prefixThen("c");
  await expect.element(terminalButtons()).toHaveLength(1);
  const pane = page.getByRole("region", { name: "active terminal" }).element();
  const sizeOf = async () => (await client.connection.api.terminals.list())[0]!.size;
  await vi.waitFor(async () => expect((await sizeOf()).cols).toBeGreaterThan(85));
  const size = await sizeOf();

  await prefixThen("b");
  await expect.element(board()).toBeVisible();
  await expect.element(boardBack()).toHaveFocus();
  // Output that arrives while the board is open proves the stream stayed attached underneath.
  const terminalId = (await client.connection.api.terminals.list())[0]!.id;
  const stream = await writeTerminal(client, terminalId, "echo board-kept-$((3*3))\n");
  await expect.poll(screenText, { timeout: 5000 }).toContain("board-kept-9");
  stream.close();
  expect(await sizeOf()).toEqual(size);
  await userEvent.keyboard("{Escape}");

  await expect.element(board()).not.toBeInTheDocument();
  expect(page.getByRole("region", { name: "active terminal" }).element()).toBe(pane);
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
});

test("a cold /board visit keeps the keyboard in the board over a live terminal", async () => {
  const seeded = await seedBoard();
  await renderApp(seeded.client, [seeded.workspaceHref, seeded.boardHref]);

  await expect.element(board()).toBeVisible();
  await expect.element(boardList()).toHaveFocus();

  // The workspace underneath is a boundary, not just a covered screen.
  const navigation = hiddenWorkspace().element();
  expect(navigation.closest("[inert]")).not.toBeNull();
  expect(navigation.closest('[aria-hidden="true"]')).not.toBeNull();

  // The terminal is live underneath: output written after the board opened reaches its screen.
  const stream = await writeTerminal(
    seeded.client,
    seeded.terminalId,
    "echo board-cold-$((2+2))\n",
  );
  await expect.poll(screenText).toContain("board-cold-4");

  // Arrows move the board's highlight, not the terminal's input.
  const options = boardList().getByRole("option");
  await expect.element(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(options.nth(1)).toHaveAttribute("aria-selected", "true");

  // Tab cannot reach the terminal. A marker written after the sentinel proves the terminal
  // parsed the input in order, so the sentinel would be on screen if it had leaked.
  await userEvent.keyboard("{Tab}");
  expect(focusedIsTerminal()).toBe(false);
  await userEvent.keyboard("board-tab-sentinel");
  stream.input("echo board-after-tab-$((3+3))\n");
  await expect.poll(screenText).toContain("board-after-tab-6");
  expect(screenText()).not.toContain("board-tab-sentinel");
  stream.close();
});

test("history Back from the board restores the terminal keyboard", async () => {
  const seeded = await seedBoard();
  const screen = await renderApp(seeded.client, [seeded.workspaceHref, seeded.boardHref]);
  await expect.element(board()).toBeVisible();
  await expect.element(boardList()).toHaveFocus();

  screen.history.back();

  await expect.element(board()).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  expect(screen.history.location.pathname).toBe("/");
  expect(screen.history.location.search).toContain(`task=${seeded.taskId}`);
  await userEvent.keyboard("echo history-back-$((5+5)){Enter}");
  await expect.poll(screenText).toContain("history-back-10");
});

test("the board's Back control returns to the same task and the terminal keyboard", async () => {
  const seeded = await seedBoard();
  const screen = await renderApp(seeded.client, [seeded.workspaceHref, seeded.boardHref]);
  await expect.element(board()).toBeVisible();

  await boardBack().click();

  await expect.element(board()).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  expect(screen.history.location.pathname).toBe("/");
  expect(screen.history.location.search).toContain(`project=${seeded.projectId}`);
  expect(screen.history.location.search).toContain(`task=${seeded.taskId}`);
  expect(screen.history.location.search).toContain(`entry=${seeded.sessionId}`);
});

test("a direct /board visit renders the layer over the workspace", async () => {
  const screen = await renderApp(newClient(), ["/board"]);

  await expect.element(board()).toBeVisible();
  await expect.element(hiddenWorkspace()).toBeVisible();
  await expect.element(boardBack()).toHaveFocus();
  await userEvent.keyboard("{Escape}");

  await expect.element(board()).not.toBeInTheDocument();
  await vi.waitFor(() => expect(screen.history.location.pathname).toBe("/"));
});

test("the board keeps the new-task draft and returns the keyboard to its prompt", async () => {
  await appWithProject(newClient());
  await prefixThen("t");
  await expect.element(promptField()).toHaveFocus();
  await userEvent.keyboard("hello board draft");

  await prefixThen("b");
  await expect.element(page.getByRole("region", { name: "Board" })).toBeVisible();
  await expect.element(boardBack()).toHaveFocus();
  await userEvent.keyboard("{Escape}");

  await expect.element(page.getByRole("region", { name: "Board" })).not.toBeInTheDocument();
  await expect.element(promptField()).toHaveValue("hello board draft");
  await expect.element(promptField()).toHaveFocus();
});

test("the board keeps a collapsed project and the sidebar's scroll", async () => {
  const { client } = await appWithProject(newClient());
  const project = client.projects.getSnapshot().projects[0]!;
  const otherProject = await client.connection.api.projects.add({
    path: await createGitRepo("other"),
  });
  await Promise.all(
    Array.from({ length: 18 }, (_, index) =>
      client.connection.api.tasks.create({
        projectId: project.id,
        title: `Board task ${index}`,
        workspace: { type: "main-worktree" },
      }),
    ),
  );
  await expect.element(taskButton("Board task 17")).toBeVisible();
  const list = workspace().element().querySelector<HTMLElement>(".overflow-y-auto");
  if (list === null) throw new Error("the sidebar list is not mounted");
  await vi.waitFor(() => expect(list.scrollHeight).toBeGreaterThan(list.clientHeight));
  list.scrollTop = 160;
  expect(list.scrollTop).toBe(160);

  await prefixThen("b");
  await expect.element(page.getByRole("region", { name: "Board" })).toBeVisible();
  await expect.element(boardList()).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("region", { name: "Board" })).not.toBeInTheDocument();
  expect(list.scrollTop).toBe(160);

  // A project that does not hold the current task can collapse; a board visit must not reopen it.
  await workspace()
    .getByRole("button", { name: `Collapse ${otherProject.name}` })
    .click();
  await expect
    .element(workspace().getByRole("button", { name: `Expand ${otherProject.name}` }))
    .toBeVisible();
  await prefixThen("b");
  await expect.element(page.getByRole("region", { name: "Board" })).toBeVisible();
  await expect.element(boardList()).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("region", { name: "Board" })).not.toBeInTheDocument();
  await expect
    .element(workspace().getByRole("button", { name: `Expand ${otherProject.name}` }))
    .toBeVisible();
});

test("prefix g with no blocked session says so and leaves the selection alone", async () => {
  await render(<App client={newClient()} />);
  await prefixThen("c");
  await expect.element(selectButton(0)).toHaveAttribute("aria-current", "true");

  await prefixThen("g");

  await expect.element(page.getByText("No blocked sessions.")).toBeVisible();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(selectButton(0)).toHaveAttribute("aria-current", "true");
});

test("the empty state adds a project from an inline path field", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await expect.element(page.getByText("Add a repository to start")).toBeVisible();

  const repo = await createGitRepo("inline");
  await userEvent.type(page.getByRole("textbox", { name: "Repository path" }), repo);
  await page.getByRole("button", { name: "Add", exact: true }).click();

  // With a project and no task selected the main area is the new-task view, prompt first.
  await expect.element(page.getByRole("form", { name: "New task" })).toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "Prompt" })).toHaveFocus();
  await expect.element(workspace().getByRole("button", { name: "New task" })).toBeEnabled();
  expect(workspace().getByRole("textbox").elements()).toHaveLength(0);
});

test("a refused path keeps the field and says why", async () => {
  await render(<App client={newClient()} />);

  const field = page.getByRole("textbox", { name: "Repository path" });
  await userEvent.type(field, "/not/a/repository");
  await page.getByRole("button", { name: "Add", exact: true }).click();

  await expect.element(page.getByRole("alert")).toBeVisible();
  await expect.element(field).toHaveValue("/not/a/repository");
  await expect.element(page.getByText("Add a repository to start")).toBeVisible();
});

test("a task without sessions shows the empty state with its two ways to start one", async () => {
  const { client } = await appWithProject(newClient());
  const project = client.projects.getSnapshot().projects[0]!;
  await client.connection.api.tasks.create({
    projectId: project.id,
    title: "Untouched",
    workspace: { type: "new-branch" },
  });

  await expect.element(taskButton("Untouched")).toHaveAttribute("aria-current", "true");
  await expect.element(page.getByText("No sessions")).toBeVisible();
  await page.getByRole("button", { name: "Open shell" }).click();
  await expect.element(shellTabs()).toHaveLength(1);
});

test("the task header names the task, project and branch without a hidden copy control", async () => {
  await appWithProject(newClient());
  await createTask("Header facts", { workspace: "new-worktree" });

  await expect.element(taskHeader().getByRole("heading", { name: "Header facts" })).toBeVisible();
  const where = await vi.waitFor(() => {
    const button = taskHeader()
      .getByLabelText(/^repo-.* › /)
      .element();
    if (!button.textContent?.includes(" › ")) throw new Error("the branch is not named yet");
    return button.textContent ?? "";
  });
  expect(where).toMatch(/^repo-[^ ]+ › /);
  await expect
    .element(taskHeader().getByRole("button", { name: /copy workspace path/i }))
    .not.toBeInTheDocument();
  await expect
    .element(taskHeader().getByRole("button", { name: "Task menu for Header facts" }))
    .toBeVisible();
});

test("the settle action in the header settles the task, and its menu offers rename and copy", async () => {
  const { client } = await appWithProject(newClient());
  await createTask("Settle me");
  const task = client.tasks.getSnapshot().tasks[0]!;

  await taskHeader().getByRole("button", { name: "Task menu for Settle me" }).click();
  await page.getByRole("menuitem", { name: "Settle task" }).click();
  await expect.poll(() => client.tasks.getSnapshot().tasks[0]?.state).toBe("settled");

  await taskHeader().getByRole("button", { name: "Task menu for Settle me" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Unsettle task" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Rename task…" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Copy workspace path" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  expect(task.title).toBe("Settle me");
});

test("tabs switch by click and by prefix n without losing the keyboard", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Tabs");
  await openAgentSessionPicker("terminal");
  await expect.element(page.getByRole("dialog", { name: "New agent session" })).toBeVisible();
  await userEvent.keyboard("1");
  await expect.element(sessionTab("claude")).toHaveAttribute("aria-selected", "true");
  await expect.poll(screenText).toContain("fake claude ready");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await sessionTab("shell").click();
  await expect.element(sessionTab("shell")).toHaveAttribute("aria-selected", "true");
  await expect.element(sessionTab("claude")).toHaveAttribute("aria-selected", "false");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await userEvent.keyboard("echo shell-tab-$((2*3)){Enter}");
  await expect.poll(screenText).toContain("shell-tab-6");

  await prefixThen("n");
  await expect.element(sessionTab("claude")).toHaveAttribute("aria-selected", "true");
  await expect.poll(screenText).toContain("fake claude ready");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await userEvent.keyboard("next-tab{Enter}");
  await expect.poll(screenText).toContain("fake claude got: next-tab");
});

test("an arrow key in the tab strip selects the next tab; the terminal keeps the key after that", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Arrowed");
  await openAgentSessionPicker("terminal");
  await expect.element(page.getByRole("dialog", { name: "New agent session" })).toBeVisible();
  await userEvent.keyboard("1");
  await expect.element(sessionTab("claude")).toHaveAttribute("aria-selected", "true");
  await expect.poll(screenText).toContain("fake claude ready");
  // The picker hands the keyboard back to the terminal before the test takes it away.
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  // Start on the shell tab, then take the keyboard to it as Tab navigation would.
  await sessionTab("shell").click();
  await expect.element(sessionTab("shell")).toHaveAttribute("aria-selected", "true");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  sessionTab("shell").element().focus();

  await userEvent.keyboard("{ArrowRight}");
  await expect.element(sessionTab("claude")).toHaveAttribute("aria-selected", "true");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  // The same key again: with two tabs a wrap would land on the shell, so staying on claude means
  // the remounted terminal took the key, not the strip.
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(sessionTab("claude")).toHaveAttribute("aria-selected", "true");
  await expect.element(sessionTab("shell")).toHaveAttribute("aria-selected", "false");
});

test("prefix \\ hides the sidebar, gives the window to the terminal, and shows it again", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Full width");
  await expect.element(page.getByRole("separator", { name: "Resize sidebar" })).toBeVisible();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await prefixThen("\\");
  await expect.element(page.getByRole("navigation", { name: "workspace" })).not.toBeInTheDocument();
  // The main area takes the whole window and keeps the keyboard.
  const main = page.getByRole("region", { name: "task content" }).element();
  expect(main.getBoundingClientRect().width).toBeGreaterThan(window.innerWidth - 1);
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await userEvent.keyboard("echo full-width-$((8+8)){Enter}");
  await expect.poll(screenText).toContain("full-width-16");

  await prefixThen("\\");
  await expect.element(page.getByRole("navigation", { name: "workspace" })).toBeVisible();
});

test("prefix w gives the keyboard to the sidebar list, and Enter or Escape hands it back", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("First");
  // A long title clips in the sidebar and makes the row show its tooltip on focus.
  await createTask("Second task with a long enough title to clip in the sidebar");
  await startShell();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  const second = taskButton("Second task with a long enough title");

  // The current row takes the keyboard, ring included, without the terminal losing a key first.
  await prefixThen("w");
  await expect.element(second).toHaveFocus();
  expect(second.element().matches(":focus-visible")).toBe(true);

  // The arrows walk the rows and stop at the ends; Home and End take them.
  await userEvent.keyboard("{ArrowUp}");
  await expect.element(taskButton("First")).toHaveFocus();
  await userEvent.keyboard("{ArrowUp}");
  await expect.element(taskButton("First")).toHaveFocus();
  await userEvent.keyboard("{End}");
  await expect.element(second).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(second).toHaveFocus();

  // The existing tab order still runs on from the row, and Shift+Tab walks it back.
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  await userEvent.keyboard("{Tab}");
  await expect.element(handle).toHaveFocus();
  await userEvent.keyboard("{Tab}");
  await expect.element(page.getByRole("button", { name: "Settings" })).toHaveFocus();
  await userEvent.keyboard("{Tab}");
  await expect.element(page.getByRole("button", { name: "Add project" })).toHaveFocus();
  await userEvent.keyboard("{Shift>}{Tab}{/Shift}{Shift>}{Tab}{/Shift}{Shift>}{Tab}{/Shift}");
  await expect.element(second).toHaveFocus();

  // The focused row still offers its own task menu.
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  await expect.element(page.getByRole("menuitem", { name: "Settle task" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(second).toHaveFocus();

  // Enter on the row that is already open mounts no pane, so it hands the keyboard back itself.
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await userEvent.keyboard("echo sidebar-$((3+4)){Enter}");
  await expect.poll(screenText).toContain("sidebar-7");

  // Escape leaves the list for the terminal it came from, even with the row's tooltip open.
  await prefixThen("w");
  await expect.element(second).toHaveFocus();
  await expect.element(page.getByRole("tooltip")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();

  // A composer is an opener too: Escape goes back to its prompt, not to the terminal.
  await prefixThen("t");
  await expect.element(promptField()).toHaveFocus();
  await prefixThen("w");
  await expect.element(second).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(promptField()).toHaveFocus();
});

test("prefix w from a stopped session comes back to its button on Escape", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Stopped");
  await prefixThen("x");
  const restart = page.getByRole("button", { name: "Start again" });
  await expect.element(restart).toHaveFocus();

  await prefixThen("w");
  await expect.element(taskButton("Stopped")).toHaveFocus();
  await userEvent.keyboard("{Escape}");

  await expect.element(restart).toHaveFocus();
});

test("prefix w shows a hidden sidebar before it focuses the current row", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Hidden");
  await prefixThen("\\");
  await expect.element(page.getByRole("navigation", { name: "workspace" })).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await prefixThen("w");

  await expect.element(page.getByRole("navigation", { name: "workspace" })).toBeVisible();
  await expect.element(taskButton("Hidden")).toHaveFocus();
  await expect.element(page.getByRole("button", { name: "Add project" })).not.toHaveFocus();
});

test("prefix w in an empty workspace focuses Add project and says nothing else", async () => {
  await render(<App client={newClient()} />);
  await expect.element(page.getByText("Add a repository to start")).toBeVisible();

  await prefixThen("w");

  await expect.element(page.getByRole("button", { name: "Add project" })).toHaveFocus();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
});

test("the sidebar edge resizes, keeps its width, and double-click resets it", async () => {
  const client = newClient();
  const first = await renderApp(client);
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  // Below 1180 px the device starts at 232 px instead of 264 (`layout.md`, **Shell**).
  const initial = window.innerWidth < 1180 ? 232 : 264;
  await expect.element(handle).toHaveAttribute("aria-valuenow", String(initial));

  handle.element().focus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(handle).toHaveAttribute("aria-valuenow", String(initial + 16));
  // A user action writes the preference; mounting alone does not (see the next test).
  expect(window.localStorage.getItem("corral.sidebar-width")).toBe(String(initial + 16));
  await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
  await expect.element(handle).toHaveAttribute("aria-valuenow", String(initial - 16));

  // The device keeps the width: a fresh app on the same page reads it back.
  await first.unmount();
  await renderApp(client);
  const again = page.getByRole("separator", { name: "Resize sidebar" });
  await expect.element(again).toHaveAttribute("aria-valuenow", String(initial - 16));

  await again.dblClick();
  await expect.element(again).toHaveAttribute("aria-valuenow", String(initial));
});

test("the sidebar edge is hit-testable where it overhangs the main area, and shows a hover line", async () => {
  await render(<App client={newClient()} />);
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  await expect.element(handle).toBeVisible();

  // The 6 px strip sits over <main>, which comes later and would paint and hit-test above it at
  // z-index auto: the point must resolve to the handle, not the main panel.
  const rect = handle.element().getBoundingClientRect();
  expect(rect.width).toBeGreaterThanOrEqual(6);
  const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  expect(hit === handle.element() || handle.element().contains(hit)).toBe(true);

  // Its hover line is the aside's border color, not transparent.
  expect(getComputedStyle(handle.element()).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  await handle.hover();
  await expect
    .poll(() => getComputedStyle(handle.element()).backgroundColor)
    .not.toBe("rgba(0, 0, 0, 0)");
});

test("mounting the shell does not freeze a sidebar width into the device preference", async () => {
  await render(<App client={newClient()} />);
  await expect.element(page.getByRole("separator", { name: "Resize sidebar" })).toBeVisible();

  // The default is derived from the window at start; writing it on mount would make 232 or 264
  // permanent for this profile.
  expect(window.localStorage.getItem("corral.sidebar-width")).toBeNull();
  await prefixThen("\\");
  await prefixThen("\\");
  expect(window.localStorage.getItem("corral.sidebar-width")).toBeNull();
});

test("a stored width outside 208–420 px falls back to the device default", async () => {
  // Not a width the user can have chosen: keep the entry but start from the window-dependent
  // default instead of silently clamping to a value they never picked.
  window.localStorage.setItem("corral.sidebar-width", "999");
  await render(<App client={newClient()} />);

  const initial = window.innerWidth < 1180 ? 232 : 264;
  await expect
    .element(page.getByRole("separator", { name: "Resize sidebar" }))
    .toHaveAttribute("aria-valuenow", String(initial));
  expect(window.localStorage.getItem("corral.sidebar-width")).toBe("999");
});

test("the sidebar keeps the main area's 640 px and its edge does not cover the list's scrollbar", async () => {
  await render(<App client={newClient()} />);
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  const max = Math.min(420, window.innerWidth - 640);
  await expect.element(handle).toHaveAttribute("aria-valuemax", String(max));

  handle.element().focus();
  await userEvent.keyboard("{ArrowRight}".repeat(20));
  await expect.element(handle).toHaveAttribute("aria-valuenow", String(max));
  // The main area is still at least 640 px wide.
  expect(window.innerWidth - max).toBeGreaterThanOrEqual(640);

  // The strip starts at the aside's border, so a scrollbar's edge stays grabbable.
  const aside = handle.element().parentElement!;
  expect(handle.element().getBoundingClientRect().left).toBeGreaterThanOrEqual(
    aside.getBoundingClientRect().right - 1,
  );
});

/** Pretends the window is `value` CSS pixels wide and tells the app about it. */
function pretendWindowWidth(value: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value });
  window.dispatchEvent(new Event("resize"));
}

test("a shrinking window re-clamps the sidebar and its maximum without losing a width that fits", async () => {
  await render(<App client={newClient()} />);
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  const width = () => Number(handle.element().getAttribute("aria-valuenow"));
  const original = window.innerWidth;

  // Widen to this window's maximum, then pretend the window shrank under it.
  handle.element().focus();
  await userEvent.keyboard("{ArrowRight}".repeat(20));
  const widest = Math.min(420, original - 640);
  await expect.element(handle).toHaveAttribute("aria-valuenow", String(widest));

  try {
    pretendWindowWidth(900);
    const shrunkMax = Math.min(420, 900 - 640);
    await expect.element(handle).toHaveAttribute("aria-valuemax", String(shrunkMax));
    await expect.element(handle).toHaveAttribute("aria-valuenow", String(shrunkMax));
    expect(900 - width()).toBeGreaterThanOrEqual(640);

    // A width the user chose that still fits is kept when the window grows again.
    handle.element().focus();
    await userEvent.keyboard("{ArrowLeft}".repeat(3));
    const chosen = width();
    expect(chosen).toBe(shrunkMax - 48);
    pretendWindowWidth(1000);
    await expect
      .element(handle)
      .toHaveAttribute("aria-valuemax", String(Math.min(420, 1000 - 640)));
    await expect.element(handle).toHaveAttribute("aria-valuenow", String(chosen));
  } finally {
    pretendWindowWidth(original);
  }
});

test("a window shrink shows the clamped width and growing again restores the preference", async () => {
  await render(<App client={newClient()} />);
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  const original = window.innerWidth;

  try {
    pretendWindowWidth(1600);
    handle.element().focus();
    await userEvent.keyboard("{ArrowRight}".repeat(20));
    await expect.element(handle).toHaveAttribute("aria-valuenow", "420");
    expect(window.localStorage.getItem("corral.sidebar-width")).toBe("420");

    // The shrink clamps what is shown but leaves the stored preference alone.
    pretendWindowWidth(900);
    await expect.element(handle).toHaveAttribute("aria-valuemax", "260");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "260");
    expect(window.localStorage.getItem("corral.sidebar-width")).toBe("420");

    pretendWindowWidth(1600);
    await expect.element(handle).toHaveAttribute("aria-valuemax", "420");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "420");
    expect(window.localStorage.getItem("corral.sidebar-width")).toBe("420");
  } finally {
    pretendWindowWidth(original);
  }
});

test("an arrow at the display maximum raises the preference instead of lowering it", async () => {
  const original = window.innerWidth;

  try {
    pretendWindowWidth(1600);
    await render(<App client={newClient()} />);
    const handle = page.getByRole("separator", { name: "Resize sidebar" });
    handle.element().focus();
    await userEvent.keyboard("{ArrowRight}".repeat(20));
    await expect.element(handle).toHaveAttribute("aria-valuenow", "420");
    expect(window.localStorage.getItem("corral.sidebar-width")).toBe("420");

    // At 1024 the display stops at 384 while the preference is wider. ArrowRight asks for 400, so
    // the preference must move up (or stay at 420), never down to the display maximum.
    pretendWindowWidth(1024);
    await expect.element(handle).toHaveAttribute("aria-valuemax", "384");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "384");
    handle.element().focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "384");
    expect(Number(window.localStorage.getItem("corral.sidebar-width"))).toBeGreaterThanOrEqual(400);

    // ArrowLeft still moves the display and stores what the user asked for.
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "368");
    expect(window.localStorage.getItem("corral.sidebar-width")).toBe("368");
  } finally {
    pretendWindowWidth(original);
  }
});

test("double-click at 1920 px restores the wider default", async () => {
  const original = window.innerWidth;

  try {
    pretendWindowWidth(1920);
    await render(<App client={newClient()} />);
    const handle = page.getByRole("separator", { name: "Resize sidebar" });
    await expect.element(handle).toHaveAttribute("aria-valuemax", "420");

    // Move away from the default so the reset is observable.
    handle.element().focus();
    await userEvent.keyboard("{ArrowRight}".repeat(20));
    await expect.element(handle).toHaveAttribute("aria-valuenow", "420");
    await handle.dblClick();
    await expect.element(handle).toHaveAttribute("aria-valuenow", "264");
    expect(window.localStorage.getItem("corral.sidebar-width")).toBe("264");
  } finally {
    pretendWindowWidth(original);
  }
});

test("a stored width starts clamped, returns on a grow, and a later drag wins", async () => {
  const original = window.innerWidth;
  window.localStorage.setItem("corral.sidebar-width", "420");

  try {
    pretendWindowWidth(900);
    await render(<App client={newClient()} />);
    const handle = page.getByRole("separator", { name: "Resize sidebar" });
    await expect.element(handle).toHaveAttribute("aria-valuemax", "260");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "260");
    expect(window.localStorage.getItem("corral.sidebar-width")).toBe("420");

    pretendWindowWidth(1600);
    await expect.element(handle).toHaveAttribute("aria-valuenow", "420");
    expect(window.localStorage.getItem("corral.sidebar-width")).toBe("420");

    // A drag at the narrow width is the user's new preference; growing does not resurrect 420.
    pretendWindowWidth(900);
    await expect.element(handle).toHaveAttribute("aria-valuenow", "260");
    handle.element().focus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(handle).toHaveAttribute("aria-valuenow", "244");
    expect(window.localStorage.getItem("corral.sidebar-width")).toBe("244");
    pretendWindowWidth(1600);
    await expect.element(handle).toHaveAttribute("aria-valuenow", "244");
  } finally {
    pretendWindowWidth(original);
  }
});

test("the sidebar footer shows the prefix pill while the prefix is armed and the settings icon", async () => {
  await render(<App client={newClient()} />);

  await expect.element(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await userEvent.keyboard("{Alt>}a{/Alt}");
  await expect.element(page.getByRole("status", { name: "prefix mode" })).toBeVisible();
  await expect
    .element(page.getByRole("status", { name: "prefix mode" }))
    .toMatchTextContent(/prefix…/);
  await userEvent.keyboard("q");
  await expect.element(page.getByRole("status", { name: "prefix mode" })).not.toBeInTheDocument();
});

test("the sidebar Search tasks button opens task search and returns focus to itself", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Search me");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  const opener = workspace().getByRole("button", { name: "Search tasks" });

  await opener.click();
  await expect.element(page.getByRole("dialog", { name: "Find task" })).toBeVisible();
  await userEvent.keyboard("{Escape}");

  await expect.element(page.getByRole("dialog", { name: "Find task" })).not.toBeInTheDocument();
  await expect.element(opener).toHaveFocus();
});

test("the terminal fills the padded main area and refits when the sidebar is dragged", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await prefixThen("c");
  await expect.element(terminalButtons()).toHaveLength(1);

  const sizeOf = async () => (await client.connection.api.terminals.list())[0]!.size;
  // The terminal starts at its creation size and takes the fitted box once it is mounted.
  await vi.waitFor(async () => expect((await sizeOf()).cols).toBeGreaterThan(85));

  // The 8 px frame belongs to the tab area, and xterm fits inside it (`layout.md`, **Terminal**).
  const pane = page.getByRole("region", { name: "active terminal" }).element();
  expect(getComputedStyle(pane).padding).toBe("8px");
  const host = pane.querySelector(".terminal-host");
  const screen = pane.querySelector(".xterm-screen");
  if (!host || !screen) throw new Error("the terminal is not mounted");
  expect(host.getBoundingClientRect().width).toBeCloseTo(
    pane.getBoundingClientRect().width - 16,
    0,
  );
  expect(screen.getBoundingClientRect().width).toBeLessThanOrEqual(
    host.getBoundingClientRect().width,
  );

  // A narrower box means fewer columns, and the server learns the new size.
  const before = await sizeOf();
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  handle.element().focus();
  await userEvent.keyboard("{ArrowRight}".repeat(8));
  await vi.waitFor(async () => expect((await sizeOf()).cols).toBeLessThan(before.cols));
});
