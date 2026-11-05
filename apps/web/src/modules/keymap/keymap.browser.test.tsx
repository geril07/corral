import type { CorralClient } from "@corral/client/corral-client";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { writeConfig } from "../../../test/config-command.ts";
import { prefixThen, realServerClients } from "../../../test/real-client.ts";
import { App } from "../../../test/render-app.tsx";
import {
  appWithProject,
  createTaskWithShell,
  focusedIsTerminal,
  sessionTab,
  taskButton,
  workspace,
} from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();
const terminalButtons = () => workspace().getByRole("button", { name: /^sh · / });
const shell = (name: string) => sessionTab(name);
const picker = () => page.getByRole("dialog", { name: "New agent session" });
const palette = () => page.getByRole("dialog", { name: "Command palette" });
const paletteItem = (name: RegExp) => palette().getByRole("option", { name });

/** Writes the file and waits until the client has the config the server derived from it. */
async function applyConfig(client: CorralClient, text: string, applied: () => void) {
  await writeConfig(text);
  await vi.waitFor(applied);
  await expect.poll(() => client.config.getSnapshot().loaded).toBe(true);
}

test("number keys select the n-th session of the current task in sidebar order", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Numbers");
  await prefixThen("c");
  await prefixThen("c");
  await expect.element(shell("shell 3")).toHaveAttribute("aria-selected", "true");

  await prefixThen("2");
  await expect.element(shell("shell 2")).toHaveAttribute("aria-selected", "true");
  await expect.element(shell("shell 3")).toHaveAttribute("aria-selected", "false");

  await prefixThen("1");
  await expect.element(shell("shell")).toHaveAttribute("aria-selected", "true");

  // A number past the task's sessions keeps the current one.
  await prefixThen("9");
  await expect.element(shell("shell")).toHaveAttribute("aria-selected", "true");
});

test("a config file rebinds an action and the key hint follows it", async () => {
  const { client } = await appWithProject(newClient());
  await createTaskWithShell("Keymap");
  await applyConfig(client, '[keys.bindings]\nnew-agent = "a"\n', () =>
    expect(client.config.getSnapshot().config.keys.bindings["new-agent"]).toBe("a"),
  );
  await prefixThen(" ");
  await expect.element(paletteItem(/New agent session/)).toMatchTextContent("alt+a a");
  await userEvent.keyboard("{Escape}");

  await prefixThen("a");
  await expect.element(picker()).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(picker()).not.toBeInTheDocument();

  await prefixThen("s");
  await expect.element(picker()).not.toBeInTheDocument();
});

test("the sidebar-list action is listed, rebindable, and a file chord on its default conflicts", async () => {
  const { client } = await appWithProject(newClient());
  await createTaskWithShell("Keyboard way out");
  const row = taskButton("Keyboard way out");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await prefixThen(" ");
  await expect.element(paletteItem(/Focus the sidebar list/)).toMatchTextContent("alt+a w");
  // Running it from the palette leaves the keyboard on the row, not on the closing dialog.
  await userEvent.keyboard("focus the sidebar list{Enter}");
  await expect.element(row).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  // A chord in the file wins over the default, and the default key then does nothing.
  await applyConfig(client, '[keys.bindings]\nfocus-sidebar = "y"\n', () =>
    expect(client.config.getSnapshot().config.keys.bindings["focus-sidebar"]).toBe("y"),
  );
  await prefixThen("w");
  await expect.element(row).not.toHaveFocus();
  await prefixThen("y");
  await expect.element(row).toHaveFocus();

  // The default is not a chord the file can take: the explicit entry is dropped and reported.
  await applyConfig(client, '[keys.bindings]\nboard = "w"\n', () =>
    expect(client.config.getSnapshot().problems).toHaveLength(1),
  );
  expect(client.config.getSnapshot().problems[0]).toMatchObject({ path: "keys.bindings.board" });
  await userEvent.keyboard("{Escape}");
  await prefixThen("w");
  await expect.element(row).toHaveFocus();
});

test("a config file unbinds an action, whose key then does nothing", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await applyConfig(client, '[keys.bindings]\nnew-terminal = ""\n', () =>
    expect(client.config.getSnapshot().config.keys.bindings["new-terminal"]).toBeNull(),
  );
  await prefixThen("c");

  await expect.element(terminalButtons()).toHaveLength(0);
});

test("a config file changes the prefix and every action follows it", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await applyConfig(client, '[keys]\nprefix = "ctrl+b"\n', () =>
    expect(client.config.getSnapshot().config.keys.prefix).toBe("ctrl+b"),
  );
  await expect.element(page.getByText("ctrl+b", { exact: true })).toBeVisible();

  await userEvent.keyboard("{Control>}b{/Control}c");
  await expect.element(terminalButtons()).toHaveLength(1);

  await prefixThen("c");
  await expect.element(terminalButtons()).toHaveLength(1);
});

test("from a loose terminal the palette navigates to the one task in both directions", async () => {
  const { client } = await appWithProject(newClient());
  await createTaskWithShell("Only");
  await client.connection.api.terminals.create({ size: { cols: 80, rows: 24 } });
  const noTask = workspace().getByRole("button", { name: "Scratch" });
  await expect.element(noTask).toBeVisible();

  await noTask.click();
  await prefixThen(" ");
  await expect.element(paletteItem(/Next task/)).toHaveAttribute("aria-disabled", "false");
  await expect.element(paletteItem(/Previous task/)).toHaveAttribute("aria-disabled", "false");
  await userEvent.keyboard("next task{Enter}");
  await expect.element(palette()).not.toBeInTheDocument();
  await expect.element(taskButton("Only")).toHaveAttribute("aria-current", "true");

  await noTask.click();
  await prefixThen(" ");
  await expect.element(paletteItem(/Previous task/)).toHaveAttribute("aria-disabled", "false");
  await userEvent.keyboard("previous task{Enter}");
  await expect.element(palette()).not.toBeInTheDocument();
  await expect.element(taskButton("Only")).toHaveAttribute("aria-current", "true");
});

test("config problems show as a notice whose dialog lists each one with the file path", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await applyConfig(client, '[keys.bindings]\nnew-agent = "hyper+q"\nboard = "ctrl+w"\n', () =>
    expect(client.config.getSnapshot().problems).toHaveLength(2),
  );
  const path = client.config.getSnapshot().path;

  await page.getByRole("button", { name: "config: 2 problems" }).click();
  const dialog = page.getByRole("dialog", { name: "Config problems" });

  await expect.element(dialog).toMatchTextContent(path);
  await expect.element(dialog).toMatchTextContent("error");
  await expect.element(dialog).toMatchTextContent("keys.bindings.new-agent");
  await expect.element(dialog).toMatchTextContent('unknown modifier "hyper" in "hyper+q"');
  await expect.element(dialog).toMatchTextContent("warning");
  await expect.element(dialog).toMatchTextContent("keys.bindings.board");
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
});

test("the search dialog opened from the sidebar button returns focus there, not to the terminal", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Focus");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  const opener = workspace().getByRole("button", { name: "Search tasks" });

  await opener.click();
  const find = page.getByRole("dialog", { name: "Find task" });
  await expect.element(find).toBeVisible();
  await userEvent.keyboard("{Escape}");

  await expect.element(find).not.toBeInTheDocument();
  await expect.element(opener).toHaveFocus();
});

test("the palette opens from its key, shows bindings, filters, runs an action and Escape returns to the terminal", async () => {
  const client = newClient();
  await render(<App client={client} />);

  await prefixThen(" ");
  await expect.element(palette()).toBeVisible();
  await expect.element(palette().getByRole("combobox", { name: "Commands" })).toHaveFocus();
  await expect.element(paletteItem(/New terminal/)).toMatchTextContent("alt+a c");
  await expect.element(paletteItem(/Stop session/)).toHaveAttribute("aria-disabled", "true");
  // The chat abort action is in the same table; with no chat session it is listed but disabled.
  await expect.element(paletteItem(/Abort the working turn/)).toMatchTextContent("alt+a .");
  await expect
    .element(paletteItem(/Abort the working turn/))
    .toHaveAttribute("aria-disabled", "true");

  await userEvent.keyboard("new terminal");
  await expect.element(paletteItem(/New terminal/)).toBeVisible();
  await expect.element(paletteItem(/Add project/)).not.toBeInTheDocument();

  await userEvent.keyboard("{Enter}");
  await expect.element(palette()).not.toBeInTheDocument();
  await expect.element(terminalButtons()).toHaveLength(1);
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await prefixThen(" ");
  await expect.element(palette()).toBeVisible();
  await userEvent.keyboard("agent");
  await expect.element(paletteItem(/New agent session/)).toBeVisible();
  await userEvent.keyboard("{Escape}");

  await expect.element(palette()).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await userEvent.keyboard("echo back-$((7+7)){Enter}");
  await expect.poll(() => window.corralScreenText?.() ?? "").toContain("back-14");
});

test("the palette opens the board and Escape returns to the terminal", async () => {
  await render(<App client={newClient()} />);
  await prefixThen("c");
  await expect.element(terminalButtons()).toHaveLength(1);
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await prefixThen(" ");
  await userEvent.keyboard("open board");
  await expect.element(paletteItem(/Open board/)).toBeVisible();
  await userEvent.keyboard("{Enter}");

  const board = page.getByRole("region", { name: "Board" });
  await expect.element(board).toBeVisible();
  await expect.element(board.getByRole("button", { name: "Back to workspace" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");

  await expect.element(board).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await userEvent.keyboard("echo board-palette-$((4+4)){Enter}");
  await expect.poll(() => window.corralScreenText?.() ?? "").toContain("board-palette-8");
});

test("a focus tooltip does not block the sidebar row underneath it", async () => {
  const { client } = await appWithProject(newClient());
  const project = client.projects.getSnapshot().projects[0]!;
  await client.connection.api.tasks.create({
    projectId: project.id,
    title: "Under the tooltip",
    workspace: { type: "new-branch" },
  });

  // The new-task icon always explains itself; focus opens its tooltip over the list below.
  workspace().getByRole("button", { name: "New task" }).element().focus();
  await expect.element(page.getByRole("tooltip")).toBeVisible();

  // Project grouping is the default; the tooltip must not intercept the task row's click.
  await taskButton("Under the tooltip").click();
  await expect.element(taskButton("Under the tooltip")).toHaveAttribute("aria-current", "true");
});
