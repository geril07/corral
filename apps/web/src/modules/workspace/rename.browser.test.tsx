import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import {
  prefixShifted,
  prefixThen,
  realServerClients,
  screenText,
} from "../../../test/real-client.ts";
import { App, renderApp } from "../../../test/render-app.tsx";
import {
  appWithProject,
  createTask,
  focusedIsTerminal,
  workspace,
} from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();
const palette = () => page.getByRole("dialog", { name: "Command palette" });
const paletteItem = (name: RegExp) => palette().getByRole("option", { name });
const dialog = () => page.getByRole("dialog", { name: /^Rename / });
const nameField = () => dialog().getByRole("textbox", { name: "Name" });
const row = (name: string) => workspace().getByRole("button", { name, exact: true });
const naturalLooseRows = () => workspace().getByRole("button", { name: /^sh · / });

/** Renames the entry that is current in the sidebar through its key, replacing whatever is there. */
async function renameCurrent(name: string) {
  await prefixShifted("r");
  await expect.element(nameField()).toHaveFocus();
  await userEvent.fill(nameField(), name);
  await userEvent.keyboard("{Enter}");
  await expect.element(dialog()).not.toBeInTheDocument();
}

test("a loose terminal is renamed from the palette, and every client sees the name", async () => {
  await render(<App client={newClient()} />);
  await prefixThen("c");
  await expect.element(naturalLooseRows()).toHaveLength(1);

  await prefixThen(" ");
  await expect
    .element(palette().getByRole("option", { name: /Rename session/ }))
    .toHaveAttribute("aria-disabled", "false");
  await userEvent.keyboard("rename session{Enter}");

  await expect.element(nameField()).toHaveFocus();
  await userEvent.fill(nameField(), "build logs");
  await userEvent.keyboard("{Enter}");

  await expect.element(dialog()).not.toBeInTheDocument();
  await expect.element(row("build logs")).toHaveAttribute("aria-current", "true");
  const other = newClient();
  await vi.waitFor(() =>
    expect(other.terminals.getSnapshot().terminals.map((terminal) => terminal.label)).toEqual([
      "build logs",
    ]),
  );
});

test("Escape keeps the old name and an empty name brings the natural one back", async () => {
  await render(<App client={newClient()} />);
  await prefixThen("c");
  await renameCurrent("build logs");

  await prefixShifted("r");
  await expect.element(nameField()).toHaveValue("build logs");
  await userEvent.fill(nameField(), "cancelled");
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog()).not.toBeInTheDocument();
  await expect.element(row("build logs")).toBeVisible();

  await renameCurrent("   ");
  await expect.element(naturalLooseRows()).toHaveLength(1);
});

test("a renamed terminal keeps its name when the app is opened again", async () => {
  const first = await renderApp(newClient());
  await prefixThen("c");
  await renameCurrent("build logs");
  await first.unmount();

  await renderApp(newClient());

  await expect.element(row("build logs")).toBeVisible();
});

test("a task session is renamed without restarting it, and custom names keep the duplicate numbering intact", async () => {
  await appWithProject(newClient());
  await createTask("Named");
  await prefixThen("c");
  await expect.element(row("shell 2")).toBeVisible();
  await userEvent.keyboard("echo before-$((6*7)){Enter}");
  await expect.poll(screenText).toContain("before-42");

  await row("shell").click();
  await renameCurrent("build");

  await expect.element(row("build")).toHaveAttribute("aria-current", "true");
  await expect.element(row("shell 2")).toBeVisible();
  await userEvent.keyboard("echo after-$((7*7)){Enter}");
  await expect.poll(screenText).toContain("after-49");

  await row("build").click();
  await renameCurrent("");
  await expect.element(row("shell")).toBeVisible();
  await expect.element(row("shell 2")).toBeVisible();
  await expect.element(dialog()).not.toBeInTheDocument();
});

test("the rename action is disabled while no session or terminal is selected", async () => {
  await render(<App client={newClient()} />);

  await prefixThen(" ");

  await expect
    .element(palette().getByRole("option", { name: /Rename session/ }))
    .toHaveAttribute("aria-disabled", "true");
});

test("a task is renamed from its key, and its branch and worktree stay as they were", async () => {
  const { client } = await appWithProject(newClient());
  await createTask("Old name");
  const before = client.tasks.getSnapshot().tasks[0]!;

  await prefixThen("e");
  const title = dialog().getByRole("textbox", { name: "Title" });
  await expect.element(title).toHaveFocus();
  await expect.element(title).toHaveValue("Old name");
  await userEvent.fill(title, "  Login fails on Safari  ");
  await userEvent.keyboard("{Enter}");

  await expect.element(dialog()).not.toBeInTheDocument();
  // A flat task row's name is "title — project · branch", so it is matched by its title.
  await expect
    .element(workspace().getByRole("button", { name: /^Login fails on Safari/ }))
    .toHaveAttribute("aria-current", "true");
  expect(client.tasks.getSnapshot().tasks[0]).toEqual({
    ...before,
    title: "Login fails on Safari",
    titleSource: "user",
  });
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
});

test("the palette lists the task rename and the session numbers with their keys", async () => {
  await appWithProject(newClient());
  await createTask("Palette");

  await prefixThen(" ");

  await expect.element(paletteItem(/Rename task/)).toMatchTextContent("alt+a e");
  await expect.element(paletteItem(/Rename session/)).toMatchTextContent("alt+a shift+r");
  await expect.element(paletteItem(/Go to session 1/)).toMatchTextContent("alt+a 1");
  await expect.element(paletteItem(/Go to session 1/)).toHaveAttribute("aria-disabled", "false");
  await expect.element(paletteItem(/Go to session 2/)).toHaveAttribute("aria-disabled", "true");
  await expect.element(paletteItem(/Go to session 9/)).toMatchTextContent("alt+a 9");
});

test("a keyboard rename after a button-opened dialog returns focus to the terminal", async () => {
  await appWithProject(newClient());
  await createTask("Rename focus");
  const find = workspace().getByRole("button", { name: "Find task" });

  await find.click();
  await expect.element(page.getByRole("dialog", { name: "Find task" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(find).toHaveFocus();
  await expect.element(page.getByRole("dialog", { name: "Find task" })).not.toBeInTheDocument();

  // Move the keyboard deliberately back to the terminal before the keyboard-opened dialog.
  await userEvent.click(page.getByRole("region", { name: "active terminal" }));
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await prefixShifted("r");
  await expect.element(nameField()).toHaveFocus();
  await userEvent.fill(nameField(), "focused");
  await userEvent.keyboard("{Enter}");

  await expect.element(dialog()).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await userEvent.keyboard("echo stale-$((4+4)){Enter}");
  await expect.poll(screenText).toContain("stale-8");
});
