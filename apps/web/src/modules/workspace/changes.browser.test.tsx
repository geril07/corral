import type { Project, Session, Task } from "@corral/protocol/rpc";
import { workspaceMissingMessage } from "@corral/protocol/workspace";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { removeDirectoryIn, writeFilesIn } from "../../../test/files-client.ts";
import { runGitIn } from "../../../test/git-client.ts";
import { createGitRepo } from "../../../test/git-repo.ts";
import { prefixShifted, realServerClients } from "../../../test/real-client.ts";
import { renderApp } from "../../../test/render-app.tsx";
import { sessionTab } from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();
const SIZE = { cols: 80, rows: 24 };

const changesTab = () => page.getByRole("tab", { name: "Changes" });
const fileList = () => page.getByRole("listbox", { name: "Changed files" });
const fileRow = (path: string) => fileList().getByRole("option", { name: new RegExp(path) });
const finish = () => page.getByRole("group", { name: "Finish" });

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
      // Longer than the pane: the diff must scroll sideways here, not wrap like chat's.
      "x".repeat(400),
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
    href: `/?project=${project.id}&task=${task.id}`,
  };
}

test("the Changes tab opens by key and by click, with the summary, a file row and a real diff", async () => {
  const { href } = await seed();
  await renderApp(newClient(), [href]);

  // The task's second shell session is current before the tab opens.
  await sessionTab("shell 2").click();
  await expect.element(sessionTab("shell 2")).toHaveAttribute("aria-selected", "true");

  await prefixShifted("c");

  await expect.element(changesTab()).toHaveAttribute("aria-selected", "true");
  await expect.element(page.getByText(/^2 files, \+\d+ −\d+$/)).toBeVisible();
  await expect.element(finish().getByRole("button", { name: "Stage all" })).toBeVisible();
  await expect.element(finish()).not.toMatchTextContent("Checked out now:");
  // The same controls show the no-remote reason inline, not only in a title.
  await expect.element(finish().getByText("This repository has no remote.")).toBeVisible();
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

  // Full width and no wrap (`layout.md`, **Changes**): the long added line scrolls sideways and
  // keeps its 20 px line box, where chat's diff would wrap it in the 46 rem lane.
  const additions = [
    ...root.querySelectorAll<HTMLElement>('[data-line-type="change-addition"][data-line]'),
  ];
  const longLine = additions.find((line) => (line.textContent ?? "").length > 300);
  expect(longLine, "the long added line is rendered").toBeDefined();
  expect(getComputedStyle(longLine!).whiteSpace).toBe("pre");
  expect(getComputedStyle(longLine!).lineHeight).toBe("20px");
  const code = root.querySelector<HTMLElement>("[data-code]")!;
  expect(code.scrollWidth).toBeGreaterThan(code.clientWidth);

  // Changes is selected in the companion group without changing the main group's session.
  await expect.element(sessionTab("shell 2")).toHaveAttribute("aria-selected", "true");
  await expect.element(sessionTab("shell")).not.toHaveAttribute("aria-selected", "true");
  expect(page.getByRole("tab", { selected: true }).elements()).toHaveLength(2);

  // Clicking a session tab comes back to it; the same session is still current.
  await sessionTab("shell 2").click();
  await expect.element(sessionTab("shell 2")).toHaveAttribute("aria-selected", "true");
  await expect.element(changesTab()).toHaveAttribute("aria-selected", "true");

  // And a click opens the tab as well.
  await changesTab().click();
  await expect.element(changesTab()).toHaveAttribute("aria-selected", "true");
  expect(page.getByRole("tab", { selected: true }).elements()).toHaveLength(2);
});

test("a file row spans the list and a long path truncates instead of widening it", async () => {
  const data = await seed({ files: false });
  const longPath = `src/${`deeply-nested-directory-name/`.repeat(6)}${`long-file-name-`.repeat(8)}.ts`;
  await writeFilesIn(data.task.workspacePath, {
    "README.md": "changed\n",
    [longPath]: "export const value = 1;\n",
  });
  await renderApp(newClient(), [data.href]);
  await prefixShifted("c");

  await expect.element(fileRow("README\\.md")).toBeVisible();
  await expect.element(fileRow("long-file-name")).toBeVisible();

  const list = fileList().element();
  const rows = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    // The row, its hover/selected fill and its click target span the list.
    expect(Math.abs(row.getBoundingClientRect().width - list.clientWidth)).toBeLessThan(1);
  }
  // The long path takes the component's ellipsis instead of widening the scroll container.
  expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
  const longRow = rows.find((row) => row.textContent?.includes("long-file-name"));
  const path = longRow?.querySelector<HTMLElement>('span[dir="rtl"]');
  expect(path).toBeDefined();
  expect(path!.scrollWidth).toBeGreaterThan(path!.clientWidth);
  expect(getComputedStyle(path!).textOverflow).toBe("ellipsis");
});

test("the keyboard moves through the file list and the diff follows the selection", async () => {
  const { href } = await seed();
  await renderApp(newClient(), [href]);
  await prefixShifted("c");

  // The routed shell opens Changes on its tab, not on the list; the first row is selected and
  // takes the keyboard when the user reaches the list.
  await expect.element(fileRow("README\\.md")).toHaveAttribute("aria-selected", "true");
  fileRow("README\\.md").element().focus();
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

test("Stage on a renamed row stages both paths and a commit records the rename", async () => {
  const data = await seed({ files: false });
  // Test setup for an R row with nothing staged: a worktree-only rename is `D old` plus `?? new`,
  // which the read model lists as two rows. Asking git to record the new path as intent-to-add
  // makes `git diff <base>` see the rename while the index still holds neither change.
  await runGitIn(data.task.workspacePath, ["mv", "README.md", "renamed.md"]);
  await runGitIn(data.task.workspacePath, ["reset", "HEAD", "--", "README.md", "renamed.md"]);
  await runGitIn(data.task.workspacePath, ["add", "-N", "renamed.md"]);

  await renderApp(newClient(), [data.href]);
  await prefixShifted("c");

  const row = fileRow("README\\.md → renamed\\.md");
  await expect.element(row).toBeVisible();
  await expect.element(row).toHaveAttribute("aria-selected", "true");
  await expect.element(finish().getByText("nothing staged")).toBeVisible();

  // Stage on the R row moves the deletion and the addition: the index records one rename, and the
  // bar counts both index paths.
  await finish().getByRole("button", { name: "Stage renamed.md" }).click();
  await expect.element(finish().getByText("2 staged")).toBeVisible();
  expect(
    (await runGitIn(data.task.workspacePath, ["diff", "--cached", "--name-status"])).trim(),
  ).toBe("R100\tREADME.md\trenamed.md");
  await expect.element(finish().getByRole("button", { name: "Unstage renamed.md" })).toBeVisible();

  // Commit from the bar: the rename is one commit and no old file remains in HEAD.
  await userEvent.fill(
    finish().getByRole("textbox", { name: "Commit message" }),
    "refactor: rename the readme",
  );
  await finish().getByRole("button", { name: "Commit", exact: true }).click();
  await expect.element(finish().getByText("nothing staged")).toBeVisible();
  expect(
    (await runGitIn(data.task.workspacePath, ["diff", "--cached", "--name-status"])).trim(),
  ).toBe("");
  expect(
    (await runGitIn(data.task.workspacePath, ["ls-tree", "--name-only", "HEAD"]))
      .trim()
      .split("\n"),
  ).toEqual(["renamed.md"]);

  // The committed R row still names the old path, which is now in neither the index nor the
  // worktree. An edit to the new path stages without that path, and the bar offers Unstage on the
  // new path alone; a second Stage after Unstage is safe.
  const committed = await runGitIn(data.task.workspacePath, ["show", "HEAD:renamed.md"]);
  await writeFilesIn(data.task.workspacePath, {
    "renamed.md": `${committed}edited after commit\n`,
  });
  await finish().getByRole("button", { name: "Stage renamed.md" }).click();
  await expect.element(finish().getByText("1 staged")).toBeVisible();
  await expect.element(finish().getByRole("alert")).not.toBeInTheDocument();
  expect(
    (await runGitIn(data.task.workspacePath, ["diff", "--cached", "--name-status"])).trim(),
  ).toBe("M\trenamed.md");
  await expect.element(finish().getByRole("button", { name: "Unstage renamed.md" })).toBeVisible();
  await finish().getByRole("button", { name: "Unstage renamed.md" }).click();
  await expect.element(finish().getByText("nothing staged")).toBeVisible();
  expect(
    (await runGitIn(data.task.workspacePath, ["diff", "--cached", "--name-status"])).trim(),
  ).toBe("");
  await finish().getByRole("button", { name: "Stage renamed.md" }).click();
  await expect.element(finish().getByText("1 staged")).toBeVisible();
  await expect.element(finish().getByRole("alert")).not.toBeInTheDocument();
});

test("a half-staged rename still offers Stage and stages both paths", async () => {
  const data = await seed({ files: false });
  // Half-staged: the deletion is in the index, the new path is not; intent-to-add keeps the read
  // model's one R row, and the bar must offer Stage rather than Unstage.
  await runGitIn(data.task.workspacePath, ["mv", "README.md", "renamed.md"]);
  await runGitIn(data.task.workspacePath, ["reset", "HEAD", "--", "renamed.md"]);
  await runGitIn(data.task.workspacePath, ["add", "-N", "renamed.md"]);

  await renderApp(newClient(), [data.href]);
  await prefixShifted("c");

  await expect.element(fileRow("README\\.md → renamed\\.md")).toBeVisible();
  await expect.element(finish().getByText("1 staged")).toBeVisible();
  await finish().getByRole("button", { name: "Stage renamed.md" }).click();
  await expect.element(finish().getByText("2 staged")).toBeVisible();
  expect(
    (await runGitIn(data.task.workspacePath, ["diff", "--cached", "--name-status"])).trim(),
  ).toBe("R100\tREADME.md\trenamed.md");
  await expect.element(finish().getByRole("button", { name: "Unstage renamed.md" })).toBeVisible();
});

test("Unstage on a renamed row removes both paths and keeps the worktree rename", async () => {
  const data = await seed({ files: false });
  // `git mv` leaves the rename staged, the state Stage all produces.
  await runGitIn(data.task.workspacePath, ["mv", "README.md", "renamed.md"]);

  await renderApp(newClient(), [data.href]);
  await prefixShifted("c");

  const renamedRow = fileRow("README\\.md → renamed\\.md");
  await expect.element(renamedRow).toBeVisible();
  await expect.element(renamedRow).toHaveAttribute("aria-selected", "true");
  await expect.element(finish().getByText("2 staged")).toBeVisible();
  await finish().getByRole("button", { name: "Unstage renamed.md" }).click();

  // Both index paths are gone; the worktree still holds only the new path, and the selected new
  // path is an unstaged addition whose button offers Stage again.
  await expect.element(finish().getByText("nothing staged")).toBeVisible();
  expect(
    (await runGitIn(data.task.workspacePath, ["diff", "--cached", "--name-status"])).trim(),
  ).toBe("");
  expect(
    (await runGitIn(data.task.workspacePath, ["status", "--porcelain"]))
      .trimEnd()
      .split("\n")
      .toSorted(),
  ).toEqual([" D README.md", "?? renamed.md"]);
  // The R row splits into its deletion and addition, so the list falls back to the first row; both
  // are unstaged again, and selecting the new path offers Stage.
  await expect.element(fileRow("README\\.md")).toHaveAttribute("aria-selected", "true");
  await expect.element(finish().getByRole("button", { name: "Stage README.md" })).toBeVisible();
  await fileRow("renamed\\.md").click();
  await expect.element(fileRow("renamed\\.md")).toHaveAttribute("aria-selected", "true");
  await expect.element(finish().getByRole("button", { name: "Stage renamed.md" })).toBeVisible();

  // Stage all brings the rename back, and Unstage on the R row again moves both paths.
  await finish().getByRole("button", { name: "Stage all" }).click();
  await expect.element(renamedRow).toBeVisible();
  await expect.element(finish().getByText("2 staged")).toBeVisible();
  await finish().getByRole("button", { name: "Unstage renamed.md" }).click();
  await expect.element(finish().getByText("nothing staged")).toBeVisible();
  expect(
    (await runGitIn(data.task.workspacePath, ["diff", "--cached", "--name-status"])).trim(),
  ).toBe("");
});

test("a clean task shows the empty state, and the 1024x640 list takes the top third", async () => {
  const clean = await seed({ files: false });
  const rendered = await renderApp(newClient(), [clean.href]);
  await prefixShifted("c");
  await expect.element(page.getByText("No changes yet")).toBeVisible();
  await expect.element(changesTab()).toHaveAttribute("aria-selected", "true");
  await rendered.unmount();

  const changed = await seed();
  const originalViewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1024, 640);
  try {
    await renderApp(newClient(), [changed.href]);
    await prefixShifted("c");
    await expect.element(fileList()).toBeVisible();

    // The browser runs at the 1024×640 minimum, where the list collapses to the top third so the
    // selected file's diff takes the rest (`layout.md`, **Changes**). Another file in the shard
    // may have resized the page, so this test states the viewport it measures.
    const list = fileList().element();
    const pane = list.parentElement!;
    // Another file in the shard can leave the first layout pass incomplete; wait for the pane to
    // settle instead of measuring one frame before its rows and diff have their final height.
    await expect
      .poll(() => list.getBoundingClientRect().height / pane.getBoundingClientRect().height)
      .toBeGreaterThan(0.28);
    const ratio = list.getBoundingClientRect().height / pane.getBoundingClientRect().height;
    expect(ratio).toBeLessThan(0.4);
    // The routed shell's identity row and tab strip reduce the height left for the pane, so the
    // finish controls can take more than the diff at 640 px; the diff still owns its own pane.
    const diff = document.querySelector<HTMLElement>('[aria-label="File diff"]')!;
    await expect.poll(() => diff.getBoundingClientRect().height).toBeGreaterThan(100);
  } finally {
    await page.viewport(originalViewport.width, originalViewport.height);
  }
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

test("a deleted base branch says why in the summary row instead of failing", async () => {
  const data = await seed();
  await runGitIn(data.project.path, ["switch", "-c", "elsewhere"]);
  await runGitIn(data.project.path, ["branch", "-D", "main"]);
  await writeFilesIn(data.task.workspacePath, { "local.txt": "still here\n" });

  await renderApp(newClient(), [data.href]);
  await prefixShifted("c");

  await vi.waitFor(() =>
    expect(document.body.textContent).toContain("'main' is gone; compared with HEAD"),
  );
  await expect.element(fileRow("local\\.txt")).toBeVisible();
});

test("a workspace deleted outside Corral is the named sentence in Changes, not git's raw line", async () => {
  const { task, href } = await seed();
  await renderApp(newClient(), [href]);
  // The directory goes away behind Corral's back; its git worktree entry stays stale, as it does
  // when a user removes the folder by hand.
  await removeDirectoryIn(task.workspacePath);

  await prefixShifted("c");

  const alert = page.getByRole("alert");
  await expect.element(alert).toMatchTextContent(workspaceMissingMessage(task.workspacePath));
  await expect.element(alert).not.toMatchTextContent("no such directory");
  // No files and no counts are claimed for a workspace that is gone.
  await expect.element(fileList()).not.toBeInTheDocument();
});

test("a capped list and a lower-bound total say so in Changes", async () => {
  const data = await seed({ files: false });
  const many: Record<string, string> = {};
  for (let index = 0; index < 501; index += 1) {
    many[`many/f${String(index).padStart(4, "0")}.txt`] = "x\n";
  }
  await writeFilesIn(data.task.workspacePath, many);

  await renderApp(newClient(), [data.href]);
  await prefixShifted("c");

  await expect.element(page.getByText(/the first 500 files/)).toBeVisible();
  await expect.element(page.getByText(/some counts are a lower bound/)).toBeVisible();
  expect(fileList().getByRole("option").elements()).toHaveLength(500);
});

test("reloading on the Changes tab restores the tab and the session behind it", async () => {
  const data = await seed();
  const rendered = await renderApp(newClient(), [data.href]);
  await sessionTab("shell 2").click();
  await expect.element(sessionTab("shell 2")).toHaveAttribute("aria-selected", "true");
  await prefixShifted("c");
  await expect.element(changesTab()).toHaveAttribute("aria-selected", "true");

  await rendered.unmount();
  await renderApp(newClient(), [data.href]);

  await expect.element(changesTab()).toHaveAttribute("aria-selected", "true");
  await expect.element(sessionTab("shell 2")).toHaveAttribute("aria-selected", "true");
  await expect.element(fileRow("README\\.md")).toBeVisible();
});

test("a branch renamed outside Corral stays recorded in the header and Changes names the live one", async () => {
  const data = await seed({ files: false });
  await runGitIn(data.task.workspacePath, ["branch", "-m", "renamed-outside"]);

  await renderApp(newClient(), [data.href]);
  await prefixShifted("c");
  await expect
    .element(
      finish().getByText(
        `Checked out now: renamed-outside · the task was created on ${data.task.branch}.`,
      ),
    )
    .toBeVisible();
});

test("a detached main-tree task says detached and shows why push and pull request are unavailable", async () => {
  const repo = await createGitRepo("detached");
  await runGitIn(repo, ["checkout", "--detach"]);
  const setup = newClient();
  await expect.poll(() => setup.connection.state.getSnapshot().status).toBe("connected");
  const { api } = setup.connection;
  const project = await api.projects.add({ path: repo });
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Detached work",
    workspace: { type: "main-worktree" },
  });
  // The wire keeps the create-time fact; only the display turns it into no branch.
  expect(task.branch).toBe("HEAD");

  await renderApp(newClient(), [`/?project=${project.id}&task=${task.id}`]);
  await prefixShifted("c");
  const reason = finish().getByText("This task has no branch checked out.");
  await expect.element(reason).toBeVisible();
  await expect.element(finish().getByRole("button", { name: "Push…" })).toBeDisabled();
  await expect
    .element(finish().getByRole("button", { name: "Create pull request…" }))
    .toBeDisabled();
  await expect.element(finish()).not.toMatchTextContent("Checked out now:");
});
