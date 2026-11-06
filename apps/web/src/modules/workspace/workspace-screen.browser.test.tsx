import { ORPCError } from "@orpc/client";
import type { CorralClient } from "@corral/client/corral-client";
import type { ProjectsSnapshot } from "@corral/client/projects-store";
import type { SessionsSnapshot } from "@corral/client/sessions-store";
import { Store } from "@corral/client/store";
import type { TasksSnapshot } from "@corral/client/tasks-store";
import type { TerminalsSnapshot } from "@corral/client/terminals-store";
import type { TerminalSurface } from "@corral/client/terminal-stream";
import type { WatchFailure, WatchStore } from "@corral/client/watch-store";
import { PROTOCOL_VERSION } from "@corral/protocol/handshake";
import type { TaskChanges } from "@corral/protocol/rpc";
import { workspaceMissingMessage } from "@corral/protocol/workspace";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import {
  prefixShifted,
  prefixThen,
  screenText,
  realServerClients,
} from "../../../test/real-client.ts";
import { stubClipboard } from "../../../test/clipboard.ts";
import { writeConfig } from "../../../test/config-command.ts";
import { removeDirectoryIn } from "../../../test/files-client.ts";
import { runGitIn } from "../../../test/git-client.ts";
import { serverTarget } from "../../../test/server-url.ts";
import { App, renderApp } from "../../../test/render-app.tsx";
import { createGitRepo } from "../../../test/git-repo.ts";
import {
  openAgentSessionPicker,
  appWithProject,
  clientWithHeldTaskRename,
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

/** A client whose remove-dialog `changes.files` is the test's, with everything else real. */
function clientWithWorkspaceFiles(
  real: CorralClient,
  files: (input: { id: string }) => Promise<TaskChanges>,
) {
  const changes = new Proxy(Reflect.get(real.connection.api, "changes"), {
    get(target, property, receiver) {
      return property === "files" ? files : Reflect.get(target, property, receiver);
    },
  });
  const api = new Proxy(real.connection.api, {
    get(target, property, receiver) {
      return property === "changes" ? changes : Reflect.get(target, property, receiver);
    },
  });
  const connection = { ...real.connection, api } as CorralClient["connection"];
  return { client: { ...real, connection } as CorralClient };
}

/** The last line a wrapped text laid out, from its own range: a `toBeVisible` alone can pass on clipped text. */
function lastTextLine(element: HTMLElement): DOMRect {
  const range = document.createRange();
  range.selectNodeContents(element);
  return [...range.getClientRects()].at(-1)!;
}

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
/** The header's one live region (`docs/layout.md`, **Task header**). */
const headerStatus = () => taskHeader().getByRole("status");
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
const noBlockedSessions = () => page.getByText("No blocked sessions.");

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

  await expect.element(workspace().getByText("exited (3)").last()).toBeVisible();
  await expect.element(page.getByRole("status", { name: "terminal exited" })).toBeVisible();
  await expect.poll(screenText).toContain("bye");

  await prefixThen("x");
  await expect.element(page.getByText("Add a repository to start")).toBeVisible();
});

test("a non-current loose terminal is renamed from its own menu without being selected", async () => {
  const client = newClient();
  await appWithProject(client);
  await createTask("Stays selected");
  await client.connection.api.terminals.create({ command: "/bin/sh", size: SIZE });
  const natural = workspace().getByRole("button", { name: /^sh · / });
  await expect.element(natural).toBeVisible();
  await expect.element(natural).not.toHaveAttribute("aria-current", "true");

  await natural.click({ button: "right" });
  await expect.element(page.getByRole("menuitem", { name: "Rename…" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Close terminal…" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Rename…" }).click();

  const dialog = page.getByRole("dialog", { name: /^Rename / });
  await expect.element(dialog).toBeVisible();
  await userEvent.fill(dialog.getByRole("textbox", { name: "Name" }), "build logs");
  await userEvent.keyboard("{Enter}");

  const renamed = workspace().getByRole("button", { name: "build logs", exact: true });
  await expect.element(renamed).toBeVisible();
  await expect.element(renamed).not.toHaveAttribute("aria-current", "true");
  await expect.element(taskButton("Stays selected")).toHaveAttribute("aria-current", "true");
  await vi.waitFor(() =>
    expect(client.terminals.getSnapshot().terminals.map((terminal) => terminal.label)).toEqual([
      "build logs",
    ]),
  );
});

for (const [width, height] of [
  [1024, 640],
  [1920, 1080],
] as const) {
  test(`a held rename refusal keeps the old title and one notice at ${width}×${height}`, async () => {
    const originalViewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(width, height);
    const held = clientWithHeldTaskRename(newClient(), "refuse");
    try {
      const { client } = await appWithProject(held.client);
      await createTaskWithShell("WT audit old");
      const task = client.tasks.getSnapshot().tasks[0]!;

      await prefixThen("e");
      const dialog = page.getByRole("dialog", { name: /^Rename / });
      const title = dialog.getByRole("textbox", { name: "Title" });
      await expect.element(title).toHaveFocus();
      await userEvent.fill(title, "WT audit gamma");
      await userEvent.keyboard("{Enter}");

      await vi.waitFor(() =>
        expect(held.rename).toHaveBeenCalledWith({ id: task.id, title: "WT audit gamma" }),
      );
      await expect.element(dialog).not.toBeInTheDocument();
      await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

      held.release();

      const failure = page.getByRole("alert").filter({ hasText: "This task no longer exists." });
      await expect.element(failure).toBeVisible();
      expect(page.getByRole("alert").elements()).toHaveLength(1);
      await expect.element(taskButton("WT audit old")).toHaveAttribute("aria-current", "true");
      expect(client.tasks.getSnapshot().tasks[0]).toMatchObject({
        id: task.id,
        title: "WT audit old",
      });
      await expect.element(dialog).not.toBeInTheDocument();
      expect(focusedIsTerminal()).toBe(true);
      expect(document.activeElement).not.toBe(document.body);
    } finally {
      held.release();
      await page.viewport(originalViewport.width, originalViewport.height);
    }
  });
}

test("Restart reopens an exited loose terminal with the same command, folder, name and fit", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await expect.poll(() => client.connection.state.getSnapshot().status).toBe("connected");
  const { api } = client.connection;
  const folder = await createGitRepo("restart-loose");
  // An odd request size proves the mounted pane, not the create request, is what fits it.
  const control = await api.terminals.create({
    command: "/usr/bin/env",
    args: ["sh", "-i"],
    cwd: folder,
    size: { cols: 20, rows: 5 },
  });
  await api.terminals.setLabel({ id: control.id, label: "live control" });
  const dead = await api.terminals.create({
    command: "/usr/bin/env",
    args: ["sh", "-i"],
    cwd: folder,
    size: { cols: 30, rows: 8 },
  });
  await api.terminals.setLabel({ id: dead.id, label: "build logs" });
  await writeTerminal(client, dead.id, "exit 3\n");

  // Mount the control terminal, so the pane has a fitted size the restarted one must match.
  const controlRow = workspace().getByRole("button", { name: "live control", exact: true });
  await expect.element(controlRow).toBeVisible();
  await controlRow.click();
  await expect.element(page.getByRole("region", { name: "active terminal" })).toBeVisible();
  await settleLayout();
  const fitted = await vi.waitFor(async () => {
    const size = (await api.terminals.list()).find((terminal) => terminal.id === control.id)!.size;
    expect(size).not.toEqual({ cols: 20, rows: 5 });
    return size;
  });

  const deadRow = workspace().getByRole("button", { name: "build logs — exited (3)" });
  await expect.element(deadRow).toBeVisible();
  await deadRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Restart" }).click();

  const liveRow = workspace().getByRole("button", { name: "build logs", exact: true });
  await expect.element(liveRow).toBeVisible();
  await expect.element(liveRow).toHaveAttribute("aria-current", "true");
  await expect.element(deadRow).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("status", { name: "terminal exited" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("region", { name: "active terminal" })).toBeVisible();

  await vi.waitFor(async () => {
    const listed = await api.terminals.list();
    expect(listed).toHaveLength(2);
    expect(listed.map((terminal) => terminal.id)).not.toContain(dead.id);
    const restarted = listed.find((terminal) => terminal.id !== control.id)!;
    expect(restarted).toMatchObject({
      command: "/usr/bin/env",
      args: ["sh", "-i"],
      cwd: folder,
      label: "build logs",
      exit: null,
    });
    expect(restarted.size).toEqual(fitted);
  });
});

test("Restart works on a dead non-current loose terminal while a task is selected", async () => {
  const client = newClient();
  await appWithProject(client);
  await createTask("Stays selected");
  const { api } = client.connection;
  const dead = await api.terminals.create({
    command: "/usr/bin/env",
    args: ["sh", "-i"],
    size: SIZE,
  });
  await api.terminals.setLabel({ id: dead.id, label: "dead row" });
  await writeTerminal(client, dead.id, "exit 6\n");
  const deadRow = workspace().getByRole("button", { name: "dead row — exited (6)" });
  await expect.element(deadRow).toBeVisible();
  await expect.element(taskButton("Stays selected")).toHaveAttribute("aria-current", "true");

  await deadRow.click({ button: "right" });
  await expect.element(page.getByRole("menuitem", { name: "Restart" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Restart" }).click();

  const liveRow = workspace().getByRole("button", { name: "dead row", exact: true });
  await expect.element(liveRow).toBeVisible();
  await expect.element(liveRow).toHaveAttribute("aria-current", "true");
  await expect.element(deadRow).not.toBeInTheDocument();
  await expect.element(taskButton("Stays selected")).not.toHaveAttribute("aria-current", "true");

  await vi.waitFor(async () => {
    const listed = await api.terminals.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.id).not.toBe(dead.id);
    expect(listed[0]).toMatchObject({
      command: "/usr/bin/env",
      args: ["sh", "-i"],
      label: "dead row",
      exit: null,
    });
  });
});

test("a failed Restart keeps the dead row and its name, and shows the failure", async () => {
  const { client, drop } = droppableClient();
  await render(<App client={client} />);
  await expect.poll(() => client.connection.state.getSnapshot().status).toBe("connected");
  const { api } = client.connection;
  const dead = await api.terminals.create({
    command: "/bin/sh",
    args: ["-c", "exit 2"],
    size: SIZE,
  });
  await api.terminals.setLabel({ id: dead.id, label: "build logs" });
  const deadRow = workspace().getByRole("button", { name: "build logs — exited (2)" });
  await expect.element(deadRow).toBeVisible();

  drop();
  await expect.poll(() => client.connection.state.getSnapshot().status).toBe("disconnected");
  await deadRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Restart" }).click();

  await expect
    .element(
      page
        .getByRole("alert")
        .filter({ hasText: "The server is not connected, so the action was not sent." }),
    )
    .toBeVisible();
  await expect.element(deadRow).toBeVisible();
  await expect.element(deadRow).toHaveAttribute("aria-label", "build logs — exited (2)");
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
  await expect.element(opener).toHaveTextContent("Offline");
  expect(opener.element().getAttribute("aria-label")).toMatch(
    /^connection: Cannot reach the server · attempt \d+ · \d+ s$/,
  );
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

test("selecting a task clears the guidance that asked for one", async () => {
  const { client } = await appWithProject(newClient());
  await createTask("Needs a selection");

  // A loose terminal is the no-task selection: the scratch group itself is a container, not a
  // row that can be current.
  await client.connection.api.terminals.create({ size: SIZE });
  const loose = workspace().getByRole("button", { name: /^sh · / });
  await expect.element(loose).toBeVisible();
  await loose.click();
  await expect.element(taskButton("Needs a selection")).not.toHaveAttribute("aria-current", "true");

  await prefixShifted("c");
  const notice = page.getByText("Select a task to see its changes.");
  await expect.element(notice).toBeVisible();

  // The task row is the navigation the notice asked for; choose() spends it.
  await taskButton("Needs a selection").click();
  await expect.element(notice).not.toBeInTheDocument();
  await expect.element(taskButton("Needs a selection")).toHaveAttribute("aria-current", "true");
});

test("a route change clears a failure on push, Back and Forward", async () => {
  const setup = newClient();
  await expect.poll(() => setup.connection.state.getSnapshot().status).toBe("connected");
  const { api } = setup.connection;
  const project = await api.projects.add({ path: await createGitRepo("route-clear") });
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Route task",
    workspace: { type: "main-worktree" },
  });
  const session = await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });
  const projectHref = `/?project=${project.id}`;
  const taskHref = `/?project=${project.id}&task=${task.id}&entry=${session.id}`;
  const screen = await renderApp(newClient(), [projectHref]);

  await expect.element(taskButton("Route task")).toBeVisible();
  await prefixThen("g");
  await expect.element(noBlockedSessions()).toBeVisible();

  // The pushed route names a task: navigation the effect, not choose(), applies.
  screen.history.push(taskHref);
  await expect.element(noBlockedSessions()).not.toBeInTheDocument();

  await prefixThen("g");
  await expect.element(noBlockedSessions()).toBeVisible();
  screen.history.back();
  await expect.element(noBlockedSessions()).not.toBeInTheDocument();

  await prefixThen("g");
  await expect.element(noBlockedSessions()).toBeVisible();
  screen.history.forward();
  await expect.element(noBlockedSessions()).not.toBeInTheDocument();
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

test("dismissing a failure returns the keyboard to the terminal", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Dismisses");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await prefixThen("g");
  const notice = page.getByText("No blocked sessions.");
  await expect.element(notice).toBeVisible();
  const dismiss = page.getByRole("button", { name: "Dismiss status" });
  await expect.element(dismiss).toBeVisible();
  dismiss.element().focus();
  await userEvent.keyboard("{Enter}");

  await expect.element(notice).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await userEvent.keyboard("echo dismissed-$((7+7)){Enter}");
  await expect.poll(screenText).toContain("dismissed-14");
});

test("the status row keeps its whole state word at 1024 with a failure row, at 140% too", async () => {
  // The client must load the config problem before its socket drops: the footer keeps it after.
  await writeConfig('[keys.bindings]\nnew-agent = "hyper+q"\n');
  const client = await droppedWorkspace();
  await expect.element(page.getByRole("button", { name: "config: 1 problem" })).toBeVisible();
  // A failed action adds the row above; the connection state word and the row stay independent.
  await prefixThen("c");
  await expect.element(page.getByRole("alert")).toBeVisible();
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  const surface = statusSurface("footer");
  const row = surface.lastElementChild;
  if (!(row instanceof HTMLElement)) throw new Error("the footer has no row");
  const stateWord = () => {
    const word = connectionOpener()
      .element()
      .querySelector<HTMLElement>('[data-slot="connection-state"]');
    if (word === null) throw new Error("the connection opener has no state word");
    return word;
  };
  const fullSentence = () =>
    (connectionOpener().element().getAttribute("aria-label") ?? "").replace(/^connection: /, "");
  /** The state word is whole, never an ellipsis or a single letter. */
  const assertStateWordFits = () => {
    const word = stateWord();
    expect(word.textContent?.trim()).not.toBe("");
    expect(word.textContent).not.toBe("…");
    expect(word.textContent?.length ?? 0).toBeGreaterThan(1);
    expect(word.scrollWidth).toBeLessThanOrEqual(word.clientWidth + 1);
    expect(fullSentence()).toMatch(/^Cannot reach the server · attempt \d+ · \d+ s$/);
  };
  /** One line, no document overflow, and the opener inside the pane. */
  const assertRowFits = () => {
    expect(row.clientHeight).toBeGreaterThan(0);
    expect(row.scrollHeight).toBeLessThanOrEqual(row.clientHeight + 1);
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(window.innerHeight);
    const asideRect = handle.element().parentElement!.getBoundingClientRect();
    expect(connectionOpener().element().getBoundingClientRect().right).toBeLessThanOrEqual(
      asideRect.right + 1,
    );
  };
  /** The disarmed hint yields to the connection fact while the socket is down. */
  const assertNoHint = () => {
    expect(row.querySelector("kbd")).toBeNull();
    expect(page.getByText("alt+a").elements()).toHaveLength(0);
  };
  /** The armed chip replaces the hint and stays inside the row and the pane. */
  const assertBadge = () => {
    const badge = page.getByRole("status", { name: "prefix mode" }).element();
    const asideRect = handle.element().parentElement!.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const contentsRect = badge.getBoundingClientRect();
    expect(row.querySelector("kbd")).toBeNull();
    expect(contentsRect.left).toBeGreaterThanOrEqual(asideRect.left - 1);
    expect(contentsRect.right).toBeLessThanOrEqual(asideRect.right + 1);
    // The contents stay inside the one row rather than being clipped by its fixed height.
    expect(contentsRect.top).toBeGreaterThanOrEqual(rowRect.top - 1);
    expect(contentsRect.bottom).toBeLessThanOrEqual(rowRect.bottom + 1);
  };
  const withInterfaceScale = async (read: () => Promise<void>) => {
    const previous = document.documentElement.style.fontSize;
    document.documentElement.style.fontSize = "140%";
    try {
      // The chrome row reads the interface scale, so the guard is the row's own height, not 36 px.
      await vi.waitFor(() => expect(row.clientHeight).toBeGreaterThan(36));
      await read();
    } finally {
      document.documentElement.style.fontSize = previous;
    }
  };
  const withStateWordScale = (read: () => Promise<void>) =>
    withInterfaceScale(async () => {
      // A shortened word re-measures after the scale changes; the row is what the user sees.
      await vi.waitFor(() => {
        const word = stateWord();
        expect(word.scrollWidth).toBeLessThanOrEqual(word.clientWidth + 1);
      });
      await read();
    });
  const checkWidth = async (width: number) => {
    await expect.element(handle).toHaveAttribute("aria-valuenow", String(width));
    assertRowFits();
    assertNoHint();
    assertStateWordFits();
    await withStateWordScale(async () => {
      assertRowFits();
      assertNoHint();
      assertStateWordFits();
    });

    // Arming replaces the absent hint with the chord badge inside the same row.
    const height = row.clientHeight;
    await userEvent.keyboard("{Alt>}a{/Alt}");
    await expect.element(page.getByRole("status", { name: "prefix mode" })).toBeVisible();
    expect(row.clientHeight).toBe(height);
    assertRowFits();
    assertBadge();
    await withInterfaceScale(async () => {
      assertRowFits();
      assertBadge();
    });
    expect(row.clientHeight).toBe(height);

    await userEvent.keyboard("q");
    await expect.element(page.getByRole("status", { name: "prefix mode" })).not.toBeInTheDocument();
    assertRowFits();
    assertNoHint();
    assertStateWordFits();
  };

  // The device default at 1024: the narrowest footer the app shows.
  await checkWidth(232);

  // At the floor the full word has shortened; its Hint still keeps the whole sentence.
  await withStateWordScale(async () => {
    await userEvent.hover(stateWord());
    await expect
      .element(page.getByRole("tooltip"))
      .toMatchTextContent(/Cannot reach the server · attempt \d+ · \d+ s/);
    await userEvent.unhover(stateWord());
    await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
  });

  // The recovery dialog still carries the whole sentence.
  await connectionOpener().click();
  const dialog = page.getByRole("dialog", { name: "Cannot reach the server" });
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog.getByText(/Attempt \d+ · \d+ s/)).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();

  handle.element().focus();
  await userEvent.keyboard("{ArrowRight}".repeat(2));
  await checkWidth(264);
  await userEvent.keyboard("{ArrowRight}".repeat(8));
  await checkWidth(384);

  // The disarmed hint returns once the socket is back; the failure row is not what owns it.
  client.recover();
  await expect.poll(() => client.connection.state.getSnapshot().status).toBe("connected");
  await expect.element(connectionOpener()).not.toBeInTheDocument();
  await expect.element(page.getByText("alt+a")).toBeVisible();
  expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
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
      // oxlint-disable-next-line eslint/no-await-in-loop -- each poll waits for the previous layout
      await settleLayout();
      // oxlint-disable-next-line eslint/no-await-in-loop -- each poll waits for the previous layout
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

/** Runs `read` with the interface scale applied, then restores the page's own setting. */
async function withInterfaceScaleAt(scale: string, read: () => Promise<void>) {
  const previous = document.documentElement.style.fontSize;
  document.documentElement.style.fontSize = scale;
  try {
    await read();
  } finally {
    document.documentElement.style.fontSize = previous;
  }
}

/** The keyboard is on the live current row, not on a detached copy or the terminal. */
async function assertSidebarRowFocused() {
  await vi.waitFor(() => {
    const active = document.activeElement;
    expect(active instanceof HTMLElement && active.isConnected).toBe(true);
    expect(active?.matches('[data-sidebar-row][aria-current="true"]')).toBe(true);
  });
}

/** Holds animation frames so a test can take focus before the list's scheduled frame runs. */
function holdAnimationFrames() {
  const pending: FrameRequestCallback[] = [];
  const spy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    pending.push(callback);
    return pending.length;
  });
  let held = true;
  const restore = () => {
    if (!held) return;
    held = false;
    spy.mockRestore();
  };
  return {
    flush() {
      restore();
      for (const callback of pending.splice(0)) callback(performance.now());
    },
    restore,
  };
}

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

  // The same fact the chord uses: New task is enabled while the list loads, in the palette,
  // the sidebar button and the action itself.
  await prefixThen(" ");
  await expect
    .element(
      page
        .getByRole("dialog", { name: "Command palette" })
        .getByRole("option", { name: /^New task/ }),
    )
    .toHaveAttribute("aria-disabled", "false");
  await userEvent.keyboard("{Escape}");
  await expect.element(workspace().getByRole("button", { name: "New task" })).toBeEnabled();

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

test("Add project lands in the new project's composer, not a loose terminal", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await expect.element(page.getByText("Add a repository to start")).toBeVisible();
  await prefixThen("c");
  await expect.element(selectButton(0)).toHaveAttribute("aria-current", "true");

  const repo = await createGitRepo("add-composer");
  await prefixShifted("p");
  const dialog = page.getByRole("dialog", { name: "Add project" });
  await expect.element(dialog.getByRole("textbox")).toHaveFocus();
  await userEvent.keyboard(`${repo}{Enter}`);
  await expect.element(dialog).not.toBeInTheDocument();

  // The new project is zero-task: its composer is the main area, and neither the new project
  // nor the loose terminal is current while it is open.
  await expect.element(newTaskView()).toBeVisible();
  await expect.element(promptField()).toHaveFocus();
  expect(workspace().element().querySelectorAll('[aria-current="true"]')).toHaveLength(0);

  const project = await vi.waitFor(() => {
    const found = client.projects.getSnapshot().projects.find((each) => each.path === repo);
    if (found === undefined) throw new Error("the project is not in the list yet");
    return found;
  });
  await expect
    .element(workspace().getByRole("button", { name: new RegExp(`^${project.name}\\b`) }))
    .toHaveAttribute("aria-expanded", "true");
  await expect.element(workspace().getByRole("button", { name: "New task" })).toBeEnabled();
});

test("New task in a project opens its composer, and Escape returns to the selected task", async () => {
  const { client } = await appWithProject(newClient());
  const other = await client.connection.api.projects.add({
    path: await createGitRepo("other-project"),
  });
  await createTask("Stays selected");
  const selected = taskButton("Stays selected");
  await expect.element(selected).toHaveAttribute("aria-current", "true");

  await workspace()
    .getByRole("button", { name: `New task in ${other.name}` })
    .click();
  await expect.element(newTaskView()).toBeVisible();
  await expect.element(promptField()).toHaveFocus();
  await expect
    .element(newTaskView().getByRole("combobox", { name: `Project ${other.name}` }))
    .toBeVisible();

  // One value for the composer and the sidebar: no row is current, and the composer's project
  // is the group shown open. Escape leaves the composer for the selection the URL still names.
  expect(workspace().element().querySelectorAll('[aria-current="true"]')).toHaveLength(0);
  await expect
    .element(workspace().getByRole("button", { name: new RegExp(`^${other.name}\\b`) }))
    .toHaveAttribute("aria-expanded", "true");
  await userEvent.keyboard("{Escape}");
  await expect.element(newTaskView()).not.toBeInTheDocument();
  await expect.element(selected).toHaveAttribute("aria-current", "true");

  // The project row's menu offers the same action as its `+`, for the same project.
  await workspace()
    .getByRole("button", { name: new RegExp(`^${other.name}\\b`) })
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: `New task in ${other.name}` }).click();
  await expect.element(newTaskView()).toBeVisible();
  await expect.element(promptField()).toHaveFocus();
  await expect
    .element(newTaskView().getByRole("combobox", { name: `Project ${other.name}` }))
    .toBeVisible();
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
  const otherHeader = workspace().getByRole("button", {
    name: new RegExp(`^${otherProject.name}\\b`),
  });
  await otherHeader.click();
  await expect.element(otherHeader).toHaveAttribute("aria-expanded", "false");
  await prefixThen("b");
  await expect.element(page.getByRole("region", { name: "Board" })).toBeVisible();
  await expect.element(boardList()).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("region", { name: "Board" })).not.toBeInTheDocument();
  await expect.element(otherHeader).toHaveAttribute("aria-expanded", "false");
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

test("removing a project's last task falls back to its composer, not an empty main area", async () => {
  const { client } = await appWithProject(newClient());
  const project = client.projects.getSnapshot().projects[0]!;
  await client.connection.api.tasks.create({
    projectId: project.id,
    title: "Only task",
    workspace: { type: "main-worktree" },
  });
  const row = taskButton("Only task");
  await row.click();
  await expect.element(row).toHaveAttribute("aria-current", "true");

  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove task…" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect.element(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Remove task" }).click();
  await expect.element(dialog).not.toBeInTheDocument();

  // The resolver's fallback is the project's composer: the main area is never blank and no row
  // is current after the task it named is gone.
  await expect.element(newTaskView()).toBeVisible();
  expect(workspace().element().querySelectorAll('[aria-current="true"]')).toHaveLength(0);
  await expect
    .element(workspace().getByRole("button", { name: new RegExp(`^${project.name}\\b`) }))
    .toHaveAttribute("aria-expanded", "true");
});

test("removing a task whose worktree was deleted outside says it was already gone, prunes the entry and keeps the branch", async () => {
  const { client, repo } = await appWithProject(newClient());
  await createTask("Gone worktree", { workspace: "new-worktree" });
  const task = client.tasks.getSnapshot().tasks[0]!;

  // Only the directory goes away: its git worktree entry stays stale for the server to prune.
  await removeDirectoryIn(task.workspacePath);
  expect(await runGitIn(repo, ["worktree", "list", "--porcelain"])).toContain(task.workspacePath);

  await taskButton("Gone worktree").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove task…" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect.element(dialog).toMatchTextContent("already gone");
  await expect.element(dialog).toMatchTextContent(task.workspacePath);
  await expect.element(dialog).toMatchTextContent("prunes the stale git worktree entry");
  await expect.element(dialog).toMatchTextContent(`keeps the branch ${task.branch}`);

  await dialog.getByRole("button", { name: "Remove task" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(taskButton("Gone worktree")).not.toBeInTheDocument();

  // The branch stays; git no longer lists the worktree the removal pruned.
  expect(await runGitIn(repo, ["worktree", "list", "--porcelain"])).not.toContain(
    task.workspacePath,
  );
  expect(
    (await runGitIn(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).split("\n"),
  ).toContain(task.branch);
  // The action says what actually happened, and the branch fact is laid out, not clipped behind a
  // tooltip, in the 232 px footer.
  const notice = page.getByRole("status").filter({ hasText: "The directory was already gone." });
  await expect.element(notice).toBeVisible();
  const element = notice.element();
  if (!(element instanceof HTMLElement)) throw new Error("the notice is not an HTML element");
  const surface = element.closest('[data-slot="shell-status"]')!.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(element);
  expect(range.getClientRects().length).toBeGreaterThan(1);
  expect(lastTextLine(element).bottom).toBeLessThanOrEqual(surface.bottom + 1);
  expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
  expect(element.textContent).toContain(`the branch ${task.branch} remains`);
});

test("confirming Remove before the workspace read returns still says the directory was already gone", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const real = newClient();
  const { client } = clientWithWorkspaceFiles(real, async (input) => {
    await gate;
    return real.connection.api.changes.files(input);
  });
  const { repo } = await appWithProject(client);
  await createTask("Held read", { workspace: "new-worktree" });
  const task = client.tasks.getSnapshot().tasks[0]!;
  await removeDirectoryIn(task.workspacePath);

  await taskButton("Held read").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove task…" }).click();
  const dialog = page.getByRole("alertdialog");
  // The read is held, so the ordinary copy is what the user confirms.
  await expect.element(dialog).toMatchTextContent("removes the worktree at");
  await dialog.getByRole("button", { name: "Remove task" }).click();
  release();

  await expect.element(dialog).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("status").filter({ hasText: "The directory was already gone." }))
    .toBeVisible();
  expect(await runGitIn(repo, ["worktree", "list", "--porcelain"])).not.toContain(
    task.workspacePath,
  );
  expect(
    (await runGitIn(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).split("\n"),
  ).toContain(task.branch);
});

test("Cancel while the confirmation's workspace read is pending removes nothing", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  let bothReads!: () => void;
  const settled = new Promise<void>((resolve) => {
    bothReads = resolve;
  });
  const real = newClient();
  const { client } = clientWithWorkspaceFiles(real, async (input) => {
    await gate;
    const snapshot = await real.connection.api.changes.files(input);
    reads += 1;
    if (reads === 2) bothReads();
    return snapshot;
  });
  const { repo } = await appWithProject(client);
  await createTask("Cancel me", { workspace: "new-worktree" });
  const task = client.tasks.getSnapshot().tasks[0]!;
  await removeDirectoryIn(task.workspacePath);

  await taskButton("Cancel me").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove task…" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect.element(dialog).toMatchTextContent("removes the worktree at");
  await dialog.getByRole("button", { name: "Remove task" }).click();
  // The confirmation is waiting for its own read; Cancel is still the user's to press.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect.element(dialog).not.toBeInTheDocument();

  release();
  await settled;
  await vi.waitFor(() => expect(reads).toBe(2));

  // The read answered after the dialog closed; the abort means nothing was removed.
  expect(client.tasks.getSnapshot().tasks.map((each) => each.id)).toContain(task.id);
  await expect.element(taskButton("Cancel me")).toBeVisible();
  expect(await runGitIn(repo, ["worktree", "list", "--porcelain"])).toContain(task.workspacePath);
  await expect
    .element(page.getByRole("status").filter({ hasText: "The directory was already gone." }))
    .not.toBeInTheDocument();
});

test("a failed workspace read refuses the removal instead of pruning silently", async () => {
  const real = newClient();
  const { client } = clientWithWorkspaceFiles(real, () =>
    Promise.reject(
      new ORPCError("GIT_FAILED", {
        defined: true,
        data: { message: "fatal: not a git repository" },
      }),
    ),
  );
  const { repo } = await appWithProject(client);
  await createTask("Read fails", { workspace: "new-worktree" });
  const task = client.tasks.getSnapshot().tasks[0]!;
  await removeDirectoryIn(task.workspacePath);

  await taskButton("Read fails").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove task…" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect.element(dialog).toMatchTextContent("removes the worktree at");
  await dialog.getByRole("button", { name: "Remove task" }).click();

  await expect.element(dialog.getByRole("alert")).toMatchTextContent("fatal: not a git repository");
  await expect.element(dialog).toBeVisible();
  expect(client.tasks.getSnapshot().tasks.map((each) => each.id)).toContain(task.id);
  expect(await runGitIn(repo, ["worktree", "list", "--porcelain"])).toContain(task.workspacePath);
});

test("starting a shell in a worktree deleted outside shows the named sentence in the pane, with no terminal", async () => {
  const { client } = await appWithProject(newClient());
  await createTask("Shell away", { workspace: "new-worktree" });
  const task = client.tasks.getSnapshot().tasks[0]!;
  await removeDirectoryIn(task.workspacePath);

  await page.getByRole("button", { name: "Open shell" }).click();

  const pane = page.getByRole("region", { name: "failed session" });
  await expect.element(pane).toBeVisible();
  const alert = pane.getByRole("alert");
  await expect.element(alert).toMatchTextContent(workspaceMissingMessage(task.workspacePath));
  // The raw line node-pty prints for a missing cwd is what this preflight replaces.
  await expect.element(alert).not.toMatchTextContent("chdir");
  await expect.element(alert).not.toMatchTextContent("Process exited with code 1");
  await expect.element(shellTabs()).toHaveLength(1);
});

test("a task without sessions shows the empty state with its two ways to start one", async () => {
  const { client } = await appWithProject(newClient());
  const project = client.projects.getSnapshot().projects[0]!;
  await client.connection.api.tasks.create({
    projectId: project.id,
    title: "Untouched",
    workspace: { type: "new-branch" },
  });

  // Adding the project left its composer open; choosing the task is the navigation out of it.
  await taskButton("Untouched").click();
  await expect.element(taskButton("Untouched")).toHaveAttribute("aria-current", "true");
  await expect.element(page.getByText("No sessions")).toBeVisible();
  await page.getByRole("button", { name: "Open shell" }).click();
  await expect.element(shellTabs()).toHaveLength(1);
});

test("a disabled Start agent button shows the chord's reason and opens no picker", async () => {
  await writeConfig(
    "[agents.claude]\nenabled = false\n[agents.codex]\nenabled = false\n[agents.pi]\nenabled = false\n[agents.opencode]\nenabled = false\n",
  );
  const { client } = await appWithProject(newClient());
  const project = client.projects.getSnapshot().projects[0]!;
  await client.connection.api.tasks.create({
    projectId: project.id,
    title: "No agents",
    workspace: { type: "new-branch" },
  });
  await taskButton("No agents").click();
  await expect.element(page.getByText("No sessions")).toBeVisible();

  const reason = page.getByText("Every agent is disabled in the config file.");
  await page.getByRole("button", { name: "Start agent" }).click();
  await expect.element(reason).toBeVisible();
  await expect
    .element(page.getByRole("dialog", { name: "New agent session" }))
    .not.toBeInTheDocument();

  // The chord is refused by the same entry and shows the same sentence.
  await prefixThen("s");
  await expect.element(reason).toBeVisible();
  await expect
    .element(page.getByRole("dialog", { name: "New agent session" }))
    .not.toBeInTheDocument();
});

test("a project row's menu forgets it after naming its tasks, and Cancel or Escape keeps the keyboard on the row", async () => {
  const { client, rendered } = await appWithProject(newClient());
  const api = client.connection.api;
  const project = client.projects.getSnapshot().projects[0]!;
  await Promise.all(
    ["First", "Second", "Third"].map((title) =>
      api.tasks.create({ projectId: project.id, title, workspace: { type: "main-worktree" } }),
    ),
  );
  const fallbackProject = await api.projects.add({ path: await createGitRepo("fallback") });
  const fallback = await api.tasks.create({
    projectId: fallbackProject.id,
    title: "Fallback task",
    workspace: { type: "main-worktree" },
  });
  await taskButton("First").click();
  await expect.element(taskButton("First")).toHaveAttribute("aria-current", "true");
  // The Changes tab belongs to the task whose project is about to go; removal must leave it too.
  const changesTab = page.getByRole("tab", { name: "Changes" });
  await prefixShifted("c");
  await expect.element(changesTab).toHaveAttribute("aria-selected", "true");

  const projectRow = workspace().getByRole("button", { name: new RegExp(`^${project.name}\\b`) });
  const openRemove = async () => {
    await projectRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Remove project…" }).click();
  };
  await openRemove();

  const dialog = page.getByRole("alertdialog");
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog).toMatchTextContent(`Remove project "${project.name}"?`);
  await expect
    .element(dialog)
    .toMatchTextContent(
      "Forgets this project and its 3 tasks; worktrees and branches stay on disk.",
    );
  await expect.element(dialog.getByRole("button", { name: "Cancel" })).toHaveFocus();

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(projectRow).toHaveFocus();

  // Escape closes the same dialog and returns the keyboard to the same row.
  await openRemove();
  await expect.element(dialog).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(projectRow).toHaveFocus();

  await openRemove();
  await dialog.getByRole("button", { name: "Remove project" }).click();
  await expect.element(dialog).not.toBeInTheDocument();

  // Project and rows are gone; the resolver's fallback is the other project's first task, and
  // the URL and the Changes tab follow it instead of keeping the removed ids.
  await expect.element(projectRow).not.toBeInTheDocument();
  await expect.element(taskButton("First")).not.toBeInTheDocument();
  await expect.element(taskButton("Fallback task")).toHaveAttribute("aria-current", "true");
  await expect.element(changesTab).toHaveAttribute("aria-selected", "false");
  await expect.poll(() => rendered.history.location.search).toContain(`task=${fallback.id}`);
  expect(rendered.history.location.search).toContain(`project=${fallbackProject.id}`);
  expect(client.projects.getSnapshot().projects.map((each) => each.id)).toEqual([
    fallbackProject.id,
  ]);
});

test("removing a project that is not current leaves the selected task, its Changes tab and the URL alone", async () => {
  const { client, rendered } = await appWithProject(newClient());
  const api = client.connection.api;
  const currentProject = client.projects.getSnapshot().projects[0]!;
  const otherProject = await api.projects.add({ path: await createGitRepo("other-project") });
  const currentTask = await api.tasks.create({
    projectId: currentProject.id,
    title: "Current",
    workspace: { type: "main-worktree" },
  });
  await api.tasks.create({
    projectId: otherProject.id,
    title: "Other",
    workspace: { type: "main-worktree" },
  });
  await taskButton("Current").click();
  await expect.element(taskButton("Current")).toHaveAttribute("aria-current", "true");
  const changesTab = page.getByRole("tab", { name: "Changes" });
  await prefixShifted("c");
  await expect.element(changesTab).toHaveAttribute("aria-selected", "true");

  const otherRow = workspace().getByRole("button", {
    name: new RegExp(`^${otherProject.name}\\b`),
  });
  await otherRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove project…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove project" }).click();
  await expect.element(otherRow).not.toBeInTheDocument();

  await expect.element(taskButton("Current")).toHaveAttribute("aria-current", "true");
  await expect.element(changesTab).toHaveAttribute("aria-selected", "true");
  expect(rendered.history.location.search).toContain(`project=${currentProject.id}`);
  expect(rendered.history.location.search).toContain(`task=${currentTask.id}`);
});

test("removing the project whose composer is open closes it for the fallback task", async () => {
  const { client, rendered } = await appWithProject(newClient());
  const api = client.connection.api;
  const project = client.projects.getSnapshot().projects[0]!;
  const fallbackProject = await api.projects.add({
    path: await createGitRepo("composer-fallback"),
  });
  const fallback = await api.tasks.create({
    projectId: fallbackProject.id,
    title: "Fallback task",
    workspace: { type: "main-worktree" },
  });
  // Add project left this zero-task project's composer open.
  await expect.element(newTaskView()).toBeVisible();
  await expect.element(promptField()).toHaveFocus();

  const projectRow = workspace().getByRole("button", { name: new RegExp(`^${project.name}\\b`) });
  await projectRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove project…" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect
    .element(dialog)
    .toMatchTextContent("Forgets this project; worktrees and branches stay on disk.");
  await expect.element(dialog).not.toMatchTextContent("0 tasks");
  await dialog.getByRole("button", { name: "Remove project" }).click();
  await expect.element(dialog).not.toBeInTheDocument();

  await expect.element(newTaskView()).not.toBeInTheDocument();
  await expect.element(taskButton("Fallback task")).toHaveAttribute("aria-current", "true");
  await expect.poll(() => rendered.history.location.search).toContain(`task=${fallback.id}`);
});

test("removing a project that only holds the open composer closes it and leaves the selected task alone", async () => {
  const { client, rendered } = await appWithProject(newClient());
  const api = client.connection.api;
  const selectedProject = client.projects.getSnapshot().projects[0]!;
  const selected = await api.tasks.create({
    projectId: selectedProject.id,
    title: "Selected",
    workspace: { type: "main-worktree" },
  });
  const composerProject = await api.projects.add({ path: await createGitRepo("composer-only") });
  await taskButton("Selected").click();
  await expect.element(taskButton("Selected")).toHaveAttribute("aria-current", "true");
  const changesTab = page.getByRole("tab", { name: "Changes" });
  await prefixShifted("c");
  await expect.element(changesTab).toHaveAttribute("aria-selected", "true");
  const before = rendered.history.location.search;
  expect(before).toContain("entry=changes");

  // The + opens that project's composer over the selected task, without changing the URL.
  await workspace()
    .getByRole("button", { name: `New task in ${composerProject.name}` })
    .click();
  await expect.element(newTaskView()).toBeVisible();
  await expect
    .element(newTaskView().getByRole("combobox", { name: `Project ${composerProject.name}` }))
    .toBeVisible();
  // A notice raised while the composer is open survives the removal of a project it does not name.
  await prefixThen("g");
  await expect.element(page.getByText("No blocked sessions.")).toBeVisible();

  const composerRow = workspace().getByRole("button", {
    name: new RegExp(`^${composerProject.name}\\b`),
  });
  await composerRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove project…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove project" }).click();
  await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();

  // Escape-close parity: the composer goes, the selection's Changes tab, failure and URL stay.
  await expect.element(newTaskView()).not.toBeInTheDocument();
  await expect.element(taskButton("Selected")).toHaveAttribute("aria-current", "true");
  await expect.element(changesTab).toHaveAttribute("aria-selected", "true");
  await expect.element(page.getByText("No blocked sessions.")).toBeVisible();
  expect(rendered.history.location.search).toBe(before);
  expect(rendered.history.location.search).toContain(`task=${selected.id}`);
});

test("removing the last project lands on the empty workspace and clears its ids from the URL", async () => {
  const { client, rendered } = await appWithProject(newClient());
  const api = client.connection.api;
  const project = client.projects.getSnapshot().projects[0]!;
  const last = await api.tasks.create({
    projectId: project.id,
    title: "Last",
    workspace: { type: "main-worktree" },
  });
  await taskButton("Last").click();
  await expect.element(taskButton("Last")).toHaveAttribute("aria-current", "true");

  const projectRow = workspace().getByRole("button", { name: new RegExp(`^${project.name}\\b`) });
  await projectRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove project…" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove project" }).click();
  await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();

  await expect.element(page.getByText("Add a repository to start")).toBeVisible();
  await expect.element(projectRow).not.toBeInTheDocument();
  await vi.waitFor(() => expect(rendered.history.location.search).toContain("task=none"));
  expect(rendered.history.location.search).not.toContain(project.id);
  expect(rendered.history.location.search).not.toContain(last.id);
});

test("the remove-project dialog counts tasks created while it is open", async () => {
  const { client } = await appWithProject(newClient());
  const api = client.connection.api;
  const project = client.projects.getSnapshot().projects[0]!;
  await api.tasks.create({
    projectId: project.id,
    title: "Counted",
    workspace: { type: "main-worktree" },
  });

  const projectRow = workspace().getByRole("button", { name: new RegExp(`^${project.name}\\b`) });
  await projectRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove project…" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect
    .element(dialog)
    .toMatchTextContent(
      "Forgets this project and its 1 task; worktrees and branches stay on disk.",
    );

  // The dialog host reads the count live from the task list, not a copy taken when it opened.
  await api.tasks.create({
    projectId: project.id,
    title: "Counted later",
    workspace: { type: "main-worktree" },
  });
  await expect
    .element(dialog)
    .toMatchTextContent(
      "Forgets this project and its 2 tasks; worktrees and branches stay on disk.",
    );
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("removing a project with a running terminal is refused and changes nothing", async () => {
  const { client } = await appWithProject(newClient());
  const api = client.connection.api;
  const project = client.projects.getSnapshot().projects[0]!;
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Busy",
    workspace: { type: "main-worktree" },
  });
  await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });
  await taskButton("Busy").click();
  await expect.element(taskButton("Busy")).toHaveAttribute("aria-current", "true");

  const projectRow = workspace().getByRole("button", { name: new RegExp(`^${project.name}\\b`) });
  await projectRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove project…" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect
    .element(dialog)
    .toMatchTextContent(
      "Forgets this project and its 1 task; worktrees and branches stay on disk.",
    );
  await dialog.getByRole("button", { name: "Remove project" }).click();

  await expect
    .element(dialog.getByRole("alert"))
    .toMatchTextContent("The project has tasks with running terminals. Close them first.");
  // The refusal leaves the project, its task and its running session exactly as they were.
  expect(client.projects.getSnapshot().projects.map((each) => each.id)).toContain(project.id);
  expect(client.tasks.getSnapshot().tasks).toHaveLength(1);
  expect(client.sessions.getSnapshot().sessions[0]?.state).toBe("running");

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  await expect.element(projectRow).toBeVisible();
  await expect.element(taskButton("Busy")).toHaveAttribute("aria-current", "true");
  await expect.element(projectRow).toHaveFocus();
});

test("the task header names the task, project and branch without a hidden copy control", async () => {
  await appWithProject(newClient());
  await createTask("Header facts", { workspace: "new-worktree" });

  await expect.element(taskHeader().getByRole("heading", { name: "Header facts" })).toBeVisible();
  const where = await vi.waitFor(() => {
    const button = taskHeader()
      .getByLabelText(/^repo-.* \/ /)
      .element();
    if (!button.textContent?.includes(" / ")) throw new Error("the branch is not named yet");
    return button.textContent ?? "";
  });
  expect(where).toMatch(/^repo-[^ ]+ \/ /);
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

test("the header's copy items write the path and branch and announce each outcome", async () => {
  const { client } = await appWithProject(newClient());
  await createTask("Copy facts", { workspace: "new-worktree" });
  const task = client.tasks.getSnapshot().tasks[0]!;
  const clipboard = stubClipboard(async () => undefined);
  try {
    await taskHeader().getByRole("button", { name: "Task menu for Copy facts" }).click();
    await page.getByRole("menuitem", { name: "Copy workspace path" }).click();
    await expect.element(headerStatus()).toHaveTextContent("Workspace path copied");
    expect(clipboard.writeText).toHaveBeenLastCalledWith(task.workspacePath);

    await taskHeader().getByRole("button", { name: "Task menu for Copy facts" }).click();
    await vi.waitFor(() => expect(headerStatus().element().textContent).toBe(""));
    await page.getByRole("menuitem", { name: "Copy branch" }).click();
    await expect.element(headerStatus()).toHaveTextContent("Branch copied");
    expect(clipboard.writeText).toHaveBeenLastCalledWith(task.branch);
  } finally {
    clipboard.restore();
  }
});

test("a refused clipboard says so in the header and the next action clears it", async () => {
  await appWithProject(newClient());
  await createTask("Refuses copy");
  const clipboard = stubClipboard(() =>
    Promise.reject(new Error("The system denied clipboard access.")),
  );
  try {
    await taskHeader().getByRole("button", { name: "Task menu for Refuses copy" }).click();
    await page.getByRole("menuitem", { name: "Copy workspace path" }).click();
    await expect.element(headerStatus()).toHaveTextContent("The system denied clipboard access.");

    await taskHeader().getByRole("button", { name: "Task menu for Refuses copy" }).click();
    await vi.waitFor(() => expect(headerStatus().element().textContent).toBe(""));
  } finally {
    clipboard.restore();
    await userEvent.keyboard("{Escape}");
  }
});

test("both copy items and the announcement are reachable from the keyboard", async () => {
  const { client } = await appWithProject(newClient());
  await createTask("Keyboard copy", { workspace: "new-worktree" });
  const task = client.tasks.getSnapshot().tasks[0]!;
  const clipboard = stubClipboard(async () => undefined);
  const trigger = taskHeader().getByRole("button", { name: "Task menu for Keyboard copy" });
  try {
    trigger.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("menuitem", { name: "Settle task" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await expect.element(headerStatus()).toHaveTextContent("Workspace path copied");
    expect(clipboard.writeText).toHaveBeenLastCalledWith(task.workspacePath);

    // Keyboard focus does not clear the line; opening the menu does, before the next copy.
    trigger.element().focus();
    await expect.element(headerStatus()).toHaveTextContent("Workspace path copied");
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("menuitem", { name: "Settle task" })).toHaveFocus();
    await vi.waitFor(() => expect(headerStatus().element().textContent).toBe(""));
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    await expect.element(headerStatus()).toHaveTextContent("Branch copied");
    expect(clipboard.writeText).toHaveBeenLastCalledWith(task.branch);
  } finally {
    clipboard.restore();
  }
});

test("a copy confirmation belongs to its task and clears on a task switch", async () => {
  await appWithProject(newClient());
  await createTask("First copy");
  await createTask("Second copy");
  const clipboard = stubClipboard(async () => undefined);
  try {
    await taskHeader().getByRole("button", { name: "Task menu for Second copy" }).click();
    await page.getByRole("menuitem", { name: "Copy workspace path" }).click();
    await expect.element(headerStatus()).toHaveTextContent("Workspace path copied");

    await taskButton("First copy").click();
    await expect.element(page.getByRole("heading", { name: "First copy" })).toBeVisible();
    await vi.waitFor(() => expect(headerStatus().element().textContent).toBe(""));
  } finally {
    clipboard.restore();
  }
});

test("Show sidebar clears a copy confirmation on keyboard activation", async () => {
  await appWithProject(newClient());
  await createTask("Sidebar notice");
  const clipboard = stubClipboard(async () => undefined);
  try {
    await page.getByRole("button", { name: "Hide sidebar" }).click();
    const showSidebar = page.getByRole("button", { name: "Show sidebar" });
    await expect.element(showSidebar).toBeVisible();

    await taskHeader().getByRole("button", { name: "Task menu for Sidebar notice" }).click();
    await page.getByRole("menuitem", { name: "Copy workspace path" }).click();
    await expect.element(headerStatus()).toHaveTextContent("Workspace path copied");

    showSidebar.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(workspace()).toBeVisible();
    await vi.waitFor(() => expect(headerStatus().element().textContent).toBe(""));
  } finally {
    clipboard.restore();
  }
});

test("the header's branch and title can be selected with the mouse", async () => {
  const { client } = await appWithProject(newClient());
  await createTask("Selectable title", { workspace: "new-worktree" });
  const task = client.tasks.getSnapshot().tasks[0]!;

  const title = taskHeader()
    .getByRole("heading", { name: "Selectable title" })
    .element()
    .querySelector<HTMLElement>("[data-header-text]");
  if (title === null) throw new Error("the title text has no selection span");
  await userEvent.tripleClick(title);
  await vi.waitFor(() => expect(window.getSelection()?.toString().trim()).toBe("Selectable title"));

  await taskHeader()
    .getByLabelText(/^repo-.* \/ /)
    .tripleClick();
  await vi.waitFor(() => expect(window.getSelection()?.toString()).toContain(task.branch));
});

test("a header control keeps the terminal's focus on mousedown", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Keeps focus");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  const trigger = taskHeader().getByRole("button", { name: "Task menu for Keeps focus" }).element();
  const controlDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  trigger.dispatchEvent(controlDown);
  expect(controlDown.defaultPrevented).toBe(true);
  expect(focusedIsTerminal()).toBe(true);

  const heading = taskHeader().getByRole("heading", { name: "Keeps focus" }).element();
  const title = heading.querySelector<HTMLElement>("[data-header-text]");
  if (title === null) throw new Error("the title text has no selection span");

  // Only the title text is the selection route; the rest of the h1 still keeps the terminal.
  const titleDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  title.dispatchEvent(titleDown);
  expect(titleDown.defaultPrevented).toBe(false);
  const headingDown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  heading.dispatchEvent(headingDown);
  expect(headingDown.defaultPrevented).toBe(true);
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

  // A composer is an opener too: no row is current, so the list's first row takes the keyboard
  // and Escape goes back to the prompt, not to the terminal.
  await prefixThen("t");
  await expect.element(promptField()).toHaveFocus();
  await prefixThen("w");
  await expect.element(taskButton("First")).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(promptField()).toHaveFocus();
});

test("prefix w from a stopped session comes back to its button on Escape", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Stopped");
  await prefixThen("x");
  const restart = page.getByRole("button", { name: "Restart" });
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

test("prefix w from a hidden sidebar focuses the live current row at 140%", async () => {
  const { client } = await appWithProject(newClient());
  const project = client.projects.getSnapshot().projects[0]!;
  await createTaskWithShell("Shell: inspect the build");
  const current = taskButton("Shell: inspect the build");
  // Enough rows to overflow the list at 1024, as the verification's loaded workspace had.
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      client.connection.api.tasks.create({
        projectId: project.id,
        title: `Filler task ${index}`,
        workspace: { type: "main-worktree" },
      }),
    ),
  );
  await expect.element(current).toHaveAttribute("aria-current", "true");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  // At 140% the shown list measures its rows again; the current row's tooltip wrapper replaces
  // the row after the focus request, so focusing the row captured before that render lands on a
  // detached node and the terminal keeps the keyboard.
  await prefixThen("\\");
  await expect.element(page.getByRole("navigation", { name: "workspace" })).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await withInterfaceScaleAt("140%", async () => {
    await prefixThen("w");
    await expect.element(page.getByRole("navigation", { name: "workspace" })).toBeVisible();
    await assertSidebarRowFocused();

    // Enter on the already-open row hands the keyboard back to its terminal.
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
    await userEvent.keyboard("echo scale-$((6*7)){Enter}");
    await expect.poll(screenText).toContain("scale-42");

    // Escape still leaves the list for the terminal at 140%.
    await prefixThen("w");
    await assertSidebarRowFocused();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  });

  // The 100% control follows the same path; the fix must not depend on the scale.
  await prefixThen("\\");
  await expect.element(page.getByRole("navigation", { name: "workspace" })).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await prefixThen("w");
  await assertSidebarRowFocused();
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  // With the sidebar already visible, the same action still focuses the current row.
  await prefixThen("w");
  await assertSidebarRowFocused();
});

test("prefix w does not steal focus when the opener is replaced and a session tab has it", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Moved on");
  const row = taskButton("Moved on");
  const tab = sessionTab("shell");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  const frames = holdAnimationFrames();
  try {
    await prefixThen("w");
    await vi.waitFor(() =>
      expect(document.querySelector('nav[aria-label="workspace"]')).not.toBeNull(),
    );
    // The terminal's textarea was replaced, as a remount does, and the user went to the tab strip.
    const origin = page.getByRole("textbox", { name: "Terminal input" }).element();
    origin.replaceWith(origin.cloneNode(true));
    tab.element().focus();
    frames.flush();

    await expect.element(tab).toHaveFocus();
    await expect.element(row).not.toHaveFocus();
  } finally {
    frames.restore();
  }
});

test("prefix w does not steal focus when the user clicks the opener before the frame", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Clicked back");
  const row = taskButton("Clicked back");
  const terminal = page.getByRole("textbox", { name: "Terminal input" });
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  const frames = holdAnimationFrames();
  try {
    await prefixThen("w");
    await vi.waitFor(() =>
      expect(document.querySelector('nav[aria-label="workspace"]')).not.toBeNull(),
    );
    // A click on the element that already had focus changes no focus state; the pointer is the signal.
    terminal.element().dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    frames.flush();

    await expect.element(terminal).toHaveFocus();
    await expect.element(row).not.toHaveFocus();
  } finally {
    frames.restore();
  }
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
    .toMatchTextContent(/alt\+a/);
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

/** The active list's scroll box, outside the Settled shelf's own. */
const activeListBox = () => {
  const list = workspace().element().querySelector<HTMLElement>("[data-sidebar-list]");
  if (list === null) throw new Error("the active list is not mounted");
  return list;
};
const settledBox = () => {
  const box = workspace().element().querySelector<HTMLElement>("[data-shelf-list]");
  if (box === null) throw new Error("the settled shelf is not mounted");
  return box;
};
const settledRows = () => settledBox().querySelectorAll("[data-task-row]").length;
const taskState = (client: CorralClient, id: string) =>
  client.tasks.getSnapshot().tasks.find((task) => task.id === id)?.state;
/** Whether a element sits wholly inside a scroll box's visible area. */
function visibleInBox(element: Element, box: Element): boolean {
  const area = box.getBoundingClientRect();
  const rect = element.getBoundingClientRect();
  return rect.top >= area.top - 1 && rect.bottom <= area.bottom + 1;
}
const currentActiveRow = () =>
  activeListBox().querySelector<HTMLElement>('[data-task-row][aria-current="true"]');
const activeRowLabels = () =>
  [...activeListBox().querySelectorAll<HTMLElement>("[data-task-row]")].map(
    (row) => row.getAttribute("aria-label") ?? "",
  );

test("j, k and find leave the selected row in view, and j steps from the active list into the shelf", async () => {
  const { client } = await appWithProject(newClient());
  const project = client.projects.getSnapshot().projects[0]!;
  const titles = Array.from({ length: 20 }, (_, index) => `Step ${String(index).padStart(2, "0")}`);
  for (const title of titles) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- creation order is the sidebar's order
    await client.connection.api.tasks.create({
      projectId: project.id,
      title,
      workspace: { type: "main-worktree" },
    });
  }
  // Two settled tasks end the walk: `j` from the last active row selects the shelf's first.
  const archived = await client.connection.api.tasks.create({
    projectId: project.id,
    title: "Shelf task",
    workspace: { type: "main-worktree" },
  });
  await client.connection.api.tasks.setState({ id: archived.id, state: "settled" });
  const later = await client.connection.api.tasks.create({
    projectId: project.id,
    title: "Shelf later",
    workspace: { type: "main-worktree" },
  });
  await client.connection.api.tasks.setState({ id: later.id, state: "settled" });
  await expect.element(taskButton("Step 00")).toBeVisible();
  await taskButton("Step 00").click();
  await expect.element(taskButton("Step 00")).toHaveAttribute("aria-current", "true");

  const labels = activeRowLabels();
  expect(labels).toHaveLength(20);
  // Every `j` keeps the newly selected row inside the active list's visible area.
  await labels.slice(1).reduce(async (previous, label) => {
    await previous;
    await prefixThen("j");
    await vi.waitFor(() => {
      const current = currentActiveRow();
      if (current === null) throw new Error("no row is current");
      expect(current.getAttribute("aria-label")).toBe(label);
      expect(visibleInBox(current, activeListBox())).toBe(true);
    });
  }, Promise.resolve());

  // From the last active row, `j` selects the shelf's first row and opens it visibly.
  await prefixThen("j");
  const shelf = workspace().getByRole("button", { name: "Settled (2)" });
  await expect.element(shelf).toHaveAttribute("aria-expanded", "true");
  await expect.element(shelf).toBeEnabled();
  const firstShelfRow = settledBox().querySelector<HTMLElement>("[data-task-row]");
  if (firstShelfRow === null) throw new Error("the shelf has no first row");
  await vi.waitFor(() => expect(firstShelfRow.getAttribute("aria-current")).toBe("true"));
  await vi.waitFor(() => expect(visibleInBox(firstShelfRow, settledBox())).toBe(true));
  const firstShelfLabel = firstShelfRow.getAttribute("aria-label");
  if (firstShelfLabel === null) throw new Error("the shelf's first row has no name");
  const firstShelf = workspace().getByRole("button", { name: firstShelfLabel, exact: true });
  // Inspecting either must never resume it.
  expect(taskState(client, archived.id)).toBe("settled");
  expect(taskState(client, later.id)).toBe("settled");

  // `k` from the shelf's first row returns to the last active row and reveals it again.
  await prefixThen("k");
  const lastActive = workspace().getByRole("button", { name: labels.at(-1)!, exact: true });
  await expect.element(lastActive).toHaveAttribute("aria-current", "true");
  await vi.waitFor(() => expect(visibleInBox(lastActive.element(), activeListBox())).toBe(true));
  // The shelf the selection opened collapses when the selection leaves it.
  await expect.element(shelf).toHaveAttribute("aria-expanded", "false");
  await expect.element(firstShelf).not.toBeInTheDocument();

  // `prefix f` reveals the first row, even from the bottom of a long list.
  await prefixThen("f");
  const dialog = page.getByRole("dialog", { name: "Find task" });
  await expect.element(dialog).toBeVisible();
  await userEvent.keyboard(titles[0]!);
  await expect
    .element(dialog.getByRole("option", { name: new RegExp(`^${titles[0]}`) }))
    .toBeVisible();
  await userEvent.keyboard("{Enter}");
  await expect.element(dialog).not.toBeInTheDocument();
  const firstRow = workspace().getByRole("button", { name: labels[0]!, exact: true });
  await expect.element(firstRow).toHaveAttribute("aria-current", "true");
  await vi.waitFor(() => expect(visibleInBox(firstRow.element(), activeListBox())).toBe(true));
});

test("prefix \\ twice and a reload keep collapsed groups and the shelf page", async () => {
  const { client, rendered } = await appWithProject(newClient());
  const project = client.projects.getSnapshot().projects[0]!;
  for (const index of Array.from({ length: 14 }, (_, each) => each)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- each settled task needs the previous id
    const task = await client.connection.api.tasks.create({
      projectId: project.id,
      title: `Archived ${String(index).padStart(2, "0")}`,
      workspace: { type: "main-worktree" },
    });
    // oxlint-disable-next-line eslint/no-await-in-loop -- the task exists only after the create
    await client.connection.api.tasks.setState({ id: task.id, state: "settled" });
  }
  await expect.element(workspace().getByRole("button", { name: "Settled (14)" })).toBeVisible();

  // Opening the shelf is the user's choice, so it stays open after the selection leaves.
  await workspace().getByRole("button", { name: "Settled (14)" }).click();
  await workspace()
    .getByRole("button", { name: /^Archived 13/ })
    .click();
  await workspace().getByRole("button", { name: "Show more", exact: true }).click();
  await vi.waitFor(() => expect(settledRows()).toBe(8));

  // The composer is closed by the row click, so the project's own group key is the one stored.
  const header = workspace().getByRole("button", { name: new RegExp(`^${project.name}\\b`) });
  await header.click();
  await expect.element(header).toHaveAttribute("aria-expanded", "false");
  expect(JSON.parse(window.localStorage.getItem("corral.sidebar-collapsed") ?? "null")).toEqual([
    project.id,
  ]);
  expect(JSON.parse(window.localStorage.getItem("corral.sidebar-shelf") ?? "null")).toEqual({
    expanded: true,
    page: 2,
  });

  // Hiding the sidebar unmounts it; showing it again reads the device state back.
  await prefixThen("\\");
  await expect.element(workspace()).not.toBeInTheDocument();
  await prefixThen("\\");
  await expect.element(workspace()).toBeVisible();
  await expect
    .element(workspace().getByRole("button", { name: new RegExp(`^${project.name}\\b`) }))
    .toHaveAttribute("aria-expanded", "false");
  await expect
    .element(workspace().getByRole("button", { name: "Settled (14)" }))
    .toHaveAttribute("aria-expanded", "true");
  expect(settledRows()).toBe(8);

  // A reload keeps the same two facts and the selection the URL names.
  const { pathname, search, hash } = rendered.history.location;
  await rendered.unmount();
  await render(<App client={client} initialEntries={[`${pathname}${search}${hash}`]} />);
  await expect
    .element(workspace().getByRole("button", { name: new RegExp(`^${project.name}\\b`) }))
    .toHaveAttribute("aria-expanded", "false");
  await expect
    .element(workspace().getByRole("button", { name: "Settled (14)" }))
    .toHaveAttribute("aria-expanded", "true");
  await vi.waitFor(() => expect(settledRows()).toBe(8));
});
