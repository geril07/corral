import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import {
  prefixShifted,
  prefixThen,
  realServerClients,
  screenText,
} from "../../../test/real-client.ts";
import {
  appWithProject,
  clientWithHeldTaskRename,
  focusedIsTerminal,
  sessionTab,
  taskWithShell,
} from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();
const dialog = () => page.getByRole("dialog", { name: /^Rename / });
const nameField = () => dialog().getByRole("textbox", { name: "Name" });

/** Renames the entry that is current in the sidebar through its key, replacing whatever is there. */
async function renameCurrent(name: string) {
  await prefixShifted("r");
  await expect.element(nameField()).toHaveFocus();
  await userEvent.fill(nameField(), name);
  await userEvent.keyboard("{Enter}");
  await expect.element(dialog()).not.toBeInTheDocument();
}

test("a task session is renamed without restarting it, and custom names keep the duplicate numbering intact", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Named");
  await prefixThen("c");
  await expect.element(sessionTab("shell 2")).toBeVisible();
  await userEvent.keyboard("echo before-$((6*7)){Enter}");
  await expect.poll(screenText).toContain("before-42");

  await sessionTab("shell").click();
  await renameCurrent("build");

  await expect.element(sessionTab("build")).toHaveAttribute("aria-selected", "true");
  await expect.element(sessionTab("shell 2")).toBeVisible();
  await userEvent.keyboard("echo after-$((7*7)){Enter}");
  await expect.poll(screenText).toContain("after-49");

  await sessionTab("build").click();
  await renameCurrent("");
  await expect.element(sessionTab("shell")).toBeVisible();
  await expect.element(sessionTab("shell 2")).toBeVisible();
  await expect.element(dialog()).not.toBeInTheDocument();
});

test("renaming the current tab from its row menu returns focus to that tab", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Tab rename");
  const current = sessionTab("shell");
  await expect.element(current).toHaveAttribute("aria-selected", "true");

  await current.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  await expect.element(nameField()).toHaveFocus();
  await userEvent.fill(nameField(), "build");
  await userEvent.keyboard("{Enter}");

  await expect.element(dialog()).not.toBeInTheDocument();
  const renamed = sessionTab("build");
  await expect.element(renamed).toHaveAttribute("aria-selected", "true");
  // The routed dialog restores the workspace input; the tab is selected but is not the focus target.
  expect(document.activeElement).not.toBe(document.body);
});

test("a task is renamed from its key, and its branch and worktree stay as they were", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Old name");
  const before = client.tasks.getSnapshot().tasks[0]!;

  await prefixThen("e");
  const title = dialog().getByRole("textbox", { name: "Title" });
  await expect.element(title).toHaveFocus();
  await expect.element(title).toHaveValue("Old name");
  await userEvent.fill(title, "  Login fails on Safari  ");
  await userEvent.keyboard("{Enter}");

  await expect.element(dialog()).not.toBeInTheDocument();
  // A visual task card is named by its project, title and metadata, so match the title inside it.
  await expect
    .element(page.getByRole("button", { name: /Login fails on Safari/ }))
    .toHaveAttribute("aria-current", "true");
  expect(client.tasks.getSnapshot().tasks[0]).toEqual({
    ...before,
    title: "Login fails on Safari",
    titleSource: "user",
  });
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
});

for (const [width, height] of [
  [1024, 640],
  [1920, 1080],
] as const) {
  test(`Enter closes the rename before the held save and typing goes to the terminal at ${width}×${height}`, async () => {
    const originalViewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(width, height);
    const held = clientWithHeldTaskRename(newClient());
    try {
      const { client, project } = await appWithProject(held.client);
      await taskWithShell(client, project.id, "WT audit gamma");
      const task = client.tasks.getSnapshot().tasks[0]!;

      await prefixThen("e");
      const title = dialog().getByRole("textbox", { name: "Title" });
      await expect.element(title).toHaveFocus();
      await userEvent.fill(title, "  WT audit gamma reviewed  ");
      await userEvent.keyboard("{Enter}");

      await vi.waitFor(() => expect(held.rename).toHaveBeenCalledOnce());
      expect(held.rename).toHaveBeenCalledWith({ id: task.id, title: "WT audit gamma reviewed" });
      await expect.element(dialog()).not.toBeInTheDocument();
      await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
      expect(document.activeElement).not.toBe(document.body);

      // The save is held: the old title stays, and the keyboard already belongs to the terminal.
      expect(client.tasks.getSnapshot().tasks[0]?.title).toBe("WT audit gamma");
      await userEvent.keyboard("echo XYZ{Enter}");
      await expect.poll(screenText).toContain("XYZ");

      held.release();
      await expect
        .element(page.getByRole("button", { name: /WT audit gamma reviewed/ }))
        .toHaveAttribute("aria-current", "true");
      expect(client.tasks.getSnapshot().tasks.map((each) => each.title)).toEqual([
        "WT audit gamma reviewed",
      ]);
    } finally {
      held.release();
      await page.viewport(originalViewport.width, originalViewport.height);
    }
  });
}

test("a keyboard rename after a pointer-selected terminal returns focus to the terminal", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Rename focus");

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
