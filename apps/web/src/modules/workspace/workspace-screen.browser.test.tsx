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
import { serverTarget } from "../../../test/server-url.ts";
import { App, renderApp } from "../../../test/render-app.tsx";
import { createGitRepo } from "../../../test/git-repo.ts";
import {
  appWithProject,
  createTask,
  sessionTab,
  shellTabs,
  taskButton,
  taskHeader,
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
// Terminals of the test server run /bin/sh, which the sidebar labels "sh · <folder>".
const terminalButtons = () => workspace().getByRole("button", { name: /^sh · / });
const selectButton = (index: number) => terminalButtons().nth(index);

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

test("an unreachable server shows as disconnected and the workspace stays up", async () => {
  await render(<App client={newClient({ url: "ws://127.0.0.1:1", capability: "unreachable" })} />);

  await expect
    .element(page.getByRole("status", { name: /^connection:/ }))
    .toMatchTextContent("Disconnected. Retrying…");
  await expect.element(page.getByText(/If the server restarted/)).toBeVisible();
  await expect.element(workspace()).toBeVisible();
});

const focusedIsTerminal = () => document.activeElement?.classList.contains("xterm-helper-textarea");

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

test("prefix t without a project says so instead of opening the task dialog", async () => {
  await render(<App client={newClient()} />);
  await expect.element(page.getByText("Add a repository to start")).toBeVisible();

  await prefixThen("t");
  await expect.element(page.getByText(/Add a project first/)).toBeVisible();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

test("prefix b opens the board, which Escape closes and returns the keyboard from", async () => {
  await render(<App client={newClient()} />);
  await prefixThen("c");
  await expect.element(terminalButtons()).toHaveLength(1);

  await prefixThen("b");
  await expect.element(page.getByRole("region", { name: "Board" })).toBeVisible();
  await userEvent.keyboard("{Escape}");

  await expect.element(page.getByRole("region", { name: "Board" })).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
});

test("Escape on the board returns to the workspace with the previous selection", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await prefixThen("c");
  await prefixThen("c");
  await expect.element(terminalButtons()).toHaveLength(2);
  await selectButton(0).click();
  await expect.element(selectButton(0)).toHaveAttribute("aria-current", "true");

  await prefixThen("b");
  await expect.element(page.getByRole("region", { name: "Board" })).toBeVisible();
  await userEvent.keyboard("{Escape}");

  await expect.element(page.getByRole("region", { name: "Board" })).not.toBeInTheDocument();
  await expect.element(selectButton(0)).toHaveAttribute("aria-current", "true");
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

  await expect.element(page.getByText("No terminals.")).toBeVisible();
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

test("the task header names the task, its project and branch, and its agent", async () => {
  await appWithProject(newClient());
  await createTask("Header facts");

  await expect.element(taskHeader().getByRole("heading", { name: "Header facts" })).toBeVisible();
  const where = await vi.waitFor(() => {
    const button = taskHeader()
      .getByRole("button", { name: /copy workspace path$/ })
      .element();
    if (!button.textContent?.includes(" › ")) throw new Error("the branch is not named yet");
    return button.textContent ?? "";
  });
  expect(where).toMatch(/^repo-[^ ]+ › /);
  await expect
    .element(taskHeader().getByText(/no status|blocked|working|done|error|idle/))
    .toBeVisible();
  await expect.element(taskHeader().getByRole("button", { name: "Settle task" })).toBeVisible();
  await expect
    .element(taskHeader().getByRole("button", { name: "Task menu for Header facts" }))
    .toBeVisible();
});

test("the settle action in the header settles the task, and its menu offers rename and copy", async () => {
  const { client } = await appWithProject(newClient());
  await createTask("Settle me");
  const task = client.tasks.getSnapshot().tasks[0]!;

  await taskHeader().getByRole("button", { name: "Settle task" }).click();
  await expect.poll(() => client.tasks.getSnapshot().tasks[0]?.state).toBe("settled");
  await expect.element(taskHeader().getByRole("button", { name: "Unsettle task" })).toBeVisible();

  await taskHeader().getByRole("button", { name: "Task menu for Settle me" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Rename task…" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Copy workspace path" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  expect(task.title).toBe("Settle me");
});

test("tabs switch by click and by prefix n without losing the keyboard", async () => {
  await appWithProject(newClient());
  await createTask("Tabs");
  await prefixThen("s");
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

test("prefix \\ hides the sidebar, gives the window to the terminal, and shows it again", async () => {
  await appWithProject(newClient());
  await createTask("Full width");
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
  await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
  await expect.element(handle).toHaveAttribute("aria-valuenow", String(initial - 16));

  // The device keeps the width: a fresh app on the same page reads it back.
  await first.unmount();
  await renderApp(client);
  const again = page.getByRole("separator", { name: "Resize sidebar" });
  await expect.element(again).toHaveAttribute("aria-valuenow", String(initial - 16));

  again.element().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  await expect.element(again).toHaveAttribute("aria-valuenow", String(initial));
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
  await createTask("Search me");
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
