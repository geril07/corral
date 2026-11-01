import type { Project, Session, Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { writeFilesIn } from "../../../test/files-client.ts";
import { createGitRepo } from "../../../test/git-repo.ts";
import { prefixShifted, realServerClients } from "../../../test/real-client.ts";
import { renderApp } from "../../../test/render-app.tsx";
import { sessionTab, taskHeader } from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();
const SIZE = { cols: 80, rows: 24 };

const changesTab = () => page.getByRole("tab", { name: "Changes" });
const fileList = () => page.getByRole("listbox", { name: "Changed files" });
const fileRow = (path: string) => fileList().getByRole("option", { name: new RegExp(path) });

/** A diff line the library rendered, from its shadow root: the diff is real, not an error shell. */
function diffLines(): HTMLElement[] {
  const root = document.querySelector("diffs-container")?.shadowRoot;
  if (root === null || root === undefined) return [];
  return [...root.querySelectorAll<HTMLElement>("[data-line-type][data-line]")];
}

async function seed(options: { files?: boolean } = {}): Promise<{
  project: Project;
  task: Task;
  first: Session;
  second: Session;
  href: string;
}> {
  const setup = newClient();
  await expect.poll(() => setup.connection.state.getSnapshot().status).toBe("connected");
  const { api } = setup.connection;
  // The committed README is long enough that an edit at each end is two hunks with a fold.
  const committed = Array.from({ length: 40 }, (_, index) => `unchanged ${index + 1}`).join("\n");
  const project = await api.projects.add({
    path: await createGitRepo("changes", [], { "README.md": `${committed}\n` }),
  });
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Show the changes",
    workspace: { type: "new-branch" },
  });
  const first = await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });
  const second = await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });
  if (options.files !== false) {
    // Two hunks with a long unchanged stretch between them, plus an untracked file: the diff
    // folds its middle, and the list has a modified and an added row.
    const readme = [
      "changed near the top",
      ...Array.from({ length: 38 }, (_, index) => `unchanged ${index + 2}`),
      "changed near the bottom",
      "",
    ].join("\n");
    await writeFilesIn(task.workspacePath, {
      "README.md": readme,
      "src/new.ts": "export const added = 1;\nexport const other = 2;\n",
    });
  }
  return {
    project,
    task,
    first,
    second,
    href: `/?project=${project.id}&task=${task.id}&entry=${second.id}`,
  };
}

test("the Changes tab opens by key and by click, with the summary, a file row and a real diff", async () => {
  const { href } = await seed();
  await renderApp(newClient(), [href]);

  // The task's second shell session is current before the tab opens.
  await expect.element(sessionTab("shell 2")).toHaveAttribute("aria-selected", "true");

  await prefixShifted("c");

  await expect.element(changesTab()).toHaveAttribute("aria-selected", "true");
  await expect.element(page.getByText(/^2 files, \+\d+ −\d+$/)).toBeVisible();
  await expect.element(fileRow("README\\.md")).toBeVisible();
  await expect.element(fileRow("src/new\\.ts")).toBeVisible();

  // The tab has no number hint and no status glyph: it is a view, not a session.
  expect(changesTab().element().textContent).toBe("Changes");
  expect(changesTab().element().querySelector("[data-status]")).toBeNull();

  // A real rendered diff with the changed lines, not just a container.
  await vi.waitFor(() => expect(diffLines().length).toBeGreaterThan(0));
  const root = document.querySelector("diffs-container")!.shadowRoot!;
  expect(root.textContent).toContain("changed near the top");
  // The unchanged stretch between the two hunks is folded, not rendered as 40 lines.
  expect(root.querySelector("[data-separator]")).not.toBeNull();

  // Selecting the tab left the current session alone: it is marked as the one behind the tab.
  await expect.element(sessionTab("shell 2")).toHaveAttribute("aria-current", "true");
  await expect.element(sessionTab("shell 2")).not.toHaveAttribute("aria-selected", "true");
  await expect.element(sessionTab("shell")).not.toHaveAttribute("aria-current", "true");
  // Exactly one tab is selected in the strip.
  expect(page.getByRole("tab", { selected: true }).elements()).toHaveLength(1);

  // Clicking a session tab comes back to it; the same session is still current.
  await sessionTab("shell 2").click();
  await expect.element(sessionTab("shell 2")).toHaveAttribute("aria-selected", "true");
  await expect.element(changesTab()).not.toHaveAttribute("aria-selected", "true");

  // And a click opens the tab as well.
  await changesTab().click();
  await expect.element(changesTab()).toHaveAttribute("aria-selected", "true");
  expect(page.getByRole("tab", { selected: true }).elements()).toHaveLength(1);
});

test("the task header and the sidebar row show the compact counts only when non-zero", async () => {
  const { href } = await seed();
  await renderApp(newClient(), [href]);

  await vi.waitFor(() => expect(taskHeader().element().textContent).toMatch(/\+\d+ −\d+/));
  await expect
    .element(
      page
        .getByRole("navigation", { name: "workspace" })
        .getByRole("button", { name: /Show the changes.*\+\d+ −\d+/ }),
    )
    .toBeVisible();
});

test("the keyboard moves through the file list and the diff follows the selection", async () => {
  const { href } = await seed();
  await renderApp(newClient(), [href]);
  await prefixShifted("c");

  // The list holds the keyboard when the tab opens, on its first row.
  await expect.element(fileRow("README\\.md")).toHaveAttribute("aria-selected", "true");
  await expect.element(fileRow("README\\.md")).toHaveFocus();

  await userEvent.keyboard("{ArrowDown}");

  await expect.element(fileRow("src/new\\.ts")).toHaveAttribute("aria-selected", "true");
  await expect.element(fileRow("README\\.md")).not.toHaveAttribute("aria-selected", "true");
  await expect.element(fileRow("src/new\\.ts")).toHaveFocus();
  // The pane under the list now shows the other file's patch.
  await vi.waitFor(() => {
    const root = document.querySelector("diffs-container")?.shadowRoot;
    expect(root?.textContent).toContain("export const added = 1;");
  });

  await userEvent.keyboard("{Home}");
  await expect.element(fileRow("README\\.md")).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{End}");
  await expect.element(fileRow("src/new\\.ts")).toHaveAttribute("aria-selected", "true");
});

test("a clean task shows the empty state, and the 1024x640 list takes the top third", async () => {
  const clean = await seed({ files: false });
  const rendered = await renderApp(newClient(), [clean.href]);
  await prefixShifted("c");
  await expect.element(page.getByText("No changes yet")).toBeVisible();
  await expect.element(changesTab()).toHaveAttribute("aria-selected", "true");
  await rendered.unmount();

  const changed = await seed();
  await renderApp(newClient(), [changed.href]);
  await prefixShifted("c");
  await expect.element(fileList()).toBeVisible();

  // The browser runs at the 1024×640 minimum, where the list collapses to the top third so the
  // selected file's diff takes the rest (`layout.md`, **Changes**).
  const list = fileList().element();
  const pane = list.parentElement!;
  const ratio = list.getBoundingClientRect().height / pane.getBoundingClientRect().height;
  expect(ratio).toBeGreaterThan(0.28);
  expect(ratio).toBeLessThan(0.4);
  const diff = document.querySelector<HTMLElement>('[aria-label="File diff"]')!;
  expect(diff.getBoundingClientRect().height).toBeGreaterThan(list.getBoundingClientRect().height);
});

test("a binary file is one row with its size and no diff", async () => {
  const seedData = await seed({ files: false });
  await writeFilesIn(seedData.task.workspacePath, { "blob.bin": "\u0000binary\u0001" });
  await renderApp(newClient(), [seedData.href]);
  await prefixShifted("c");

  await expect.element(fileRow("blob\\.bin")).toBeVisible();
  await vi.waitFor(() => expect(document.body.textContent).toContain("Binary file, 8 B"));
  expect(diffLines()).toHaveLength(0);
});
