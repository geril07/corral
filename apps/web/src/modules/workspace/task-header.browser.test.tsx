import type { TaskNode } from "@corral/client/workspace-tree";
import type { Project, Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { removeClipboard, stubClipboard } from "../../../test/clipboard.ts";
import { TaskHeader } from "./task-header.tsx";

const project: Project = {
  id: "p1",
  name: "alpha",
  path: "/repos/alpha",
  defaultBaseBranch: "main",
};

const task = (id: string, branch: string, title: string, ownsWorktree = true): Task => ({
  id,
  projectId: project.id,
  title,
  titleSource: "user",
  prompt: null,
  primarySessionId: null,
  branch,
  workspacePath: `/work/${branch}`,
  ownsWorktree,
  state: "active",
  seenAt: null,
  createdAt: 0,
});

const nodeOf = (id: string, branch: string, title: string, ownsWorktree = true): TaskNode => ({
  task: task(id, branch, title, ownsWorktree),
  sessions: [],
});

/**
 * The header where the workspace mounts it, with the pane width under the test's control: a task
 * switch can happen while the main area has no width yet (its first paint, a hidden pane), and the
 * branch line must follow the task anyway (`docs/ux.md`, **Task header**).
 */
function Harness({
  node,
  project: headerProject = project,
  narrow,
}: {
  node: TaskNode;
  project?: Project;
  narrow: boolean;
}) {
  return (
    <div className={narrow ? "w-0 overflow-hidden" : "w-full"}>
      <TaskHeader
        node={node}
        project={headerProject}
        onSettle={() => {}}
        onRename={() => {}}
        onRemove={() => {}}
      />
    </div>
  );
}

/** Repository context is text, not a hidden copy action. */
const branchLine = () => document.querySelector("[data-task-repository]");

test("the branch line follows a task switch even when the pane has no width yet", async () => {
  const screen = await render(
    <Harness node={nodeOf("t1", "alpha-branch", "First task")} narrow={false} />,
  );
  await expect.element(page.getByText(/alpha-branch/)).toBeVisible();
  expect(branchLine()?.textContent).toBe("alpha / alpha-branch");

  // The switch lands while the pane is zero wide: the accessible label is fresh, so the visible
  // line must be too — the previous task's branch stayed on screen for as long as the width did.
  await screen.rerender(<Harness node={nodeOf("t2", "beta-branch", "Second task")} narrow />);
  expect(branchLine()?.getAttribute("aria-label")).toBe("alpha / beta-branch");
  expect(branchLine()?.textContent).toBe("alpha / beta-branch");
  await vi.waitFor(() => expect(branchLine()?.textContent).toBe("alpha / beta-branch"));
});

test("a switch with a laid-out pane shows the new branch and keeps measuring", async () => {
  const screen = await render(
    <Harness node={nodeOf("t1", "alpha-branch", "First task")} narrow={false} />,
  );
  await screen.rerender(
    <Harness node={nodeOf("t2", "beta-branch", "Second task")} narrow={false} />,
  );

  await vi.waitFor(() => expect(branchLine()?.textContent).toBe("alpha / beta-branch"));
});

test("the where segment uses the branch whether or not the task owns its worktree", async () => {
  const screen = await render(
    <Harness node={nodeOf("t1", "main", "Main task", false)} narrow={false} />,
  );
  expect(branchLine()?.textContent).toBe("alpha / main");
  await expect.element(page.getByRole("heading", { name: "Main task" })).toBeVisible();
  expect(document.querySelector("header")?.textContent).not.toContain("›");

  await screen.rerender(
    <Harness node={nodeOf("t2", "", "Branchless task", false)} narrow={false} />,
  );
  expect(branchLine()?.textContent).toBe("alpha");
  expect(branchLine()?.getAttribute("aria-label")).toBe("alpha");
  await expect.element(page.getByRole("heading", { name: "Branchless task" })).toBeVisible();
});

test("a long project and branch truncate in the middle and keep the full context", async () => {
  const longProject = { ...project, name: "orbit-observability-platform" };
  const longBranch = "feature/header-context-with-a-long-name";
  const where = `${longProject.name} / ${longBranch}`;
  await render(
    <Harness
      node={nodeOf("t1", longBranch, "Long context")}
      project={longProject}
      narrow={false}
    />,
  );

  await vi.waitFor(() => expect(branchLine()?.getAttribute("title")).toBe(where));
  expect(branchLine()?.textContent).toContain("…");
  expect(branchLine()?.getAttribute("aria-label")).toBe(where);
});

const copyStatus = () => document.querySelector('header [role="status"]');

test("both copy items write their text and confirm it in the header's status line", async () => {
  const clipboard = stubClipboard(async () => undefined);
  try {
    await render(<Harness node={nodeOf("t1", "alpha-branch", "Copyable")} narrow={false} />);

    await page.getByRole("button", { name: "Task menu for Copyable" }).click();
    await page.getByRole("menuitem", { name: "Copy workspace path" }).click();
    await vi.waitFor(() => expect(copyStatus()?.textContent).toBe("Workspace path copied"));
    await expect.element(page.getByRole("status")).toBeVisible();
    await expect.element(page.getByRole("status")).toHaveAttribute("aria-live", "polite");
    await expect.element(page.getByRole("status")).toHaveAttribute("aria-atomic", "true");
    expect(clipboard.writeText).toHaveBeenLastCalledWith("/work/alpha-branch");

    // The pointer's own mousedown also clears; the keyboard test isolates the menu's onOpenChange.
    await page.getByRole("button", { name: "Task menu for Copyable" }).click();
    await vi.waitFor(() => expect(copyStatus()?.textContent).toBe(""));
    await page.getByRole("menuitem", { name: "Copy branch" }).click();
    await vi.waitFor(() => expect(copyStatus()?.textContent).toBe("Branch copied"));
    expect(clipboard.writeText).toHaveBeenLastCalledWith("alpha-branch");
  } finally {
    clipboard.restore();
  }
});

test("the branch copy item exists only when the task has a branch", async () => {
  await render(<Harness node={nodeOf("t1", "", "Branchless")} narrow={false} />);

  await page.getByRole("button", { name: "Task menu for Branchless" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Copy workspace path" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Copy branch" })).not.toBeInTheDocument();
});

test("a refused clipboard keeps the host's sentence in the status line", async () => {
  const clipboard = stubClipboard(() =>
    Promise.reject(new Error("The system denied clipboard access.")),
  );
  try {
    await render(<Harness node={nodeOf("t1", "alpha-branch", "Refused")} narrow={false} />);

    await page.getByRole("button", { name: "Task menu for Refused" }).click();
    await page.getByRole("menuitem", { name: "Copy workspace path" }).click();
    await vi.waitFor(() =>
      expect(copyStatus()?.textContent).toBe("The system denied clipboard access."),
    );
    await expect.element(page.getByRole("status")).toBeVisible();
  } finally {
    clipboard.restore();
  }
});

test("a host without a clipboard API refuses the copy in the status line", async () => {
  const clipboard = removeClipboard();
  try {
    await render(<Harness node={nodeOf("t1", "alpha-branch", "No clipboard")} narrow={false} />);

    await page.getByRole("button", { name: "Task menu for No clipboard" }).click();
    await page.getByRole("menuitem", { name: "Copy workspace path" }).click();
    await vi.waitFor(() =>
      expect(copyStatus()?.textContent).toBe("Clipboard access is unavailable."),
    );
    await expect.element(page.getByRole("status")).toBeVisible();
    await expect.element(page.getByRole("status")).toHaveAttribute("aria-live", "polite");
    await expect.element(page.getByRole("status")).toHaveAttribute("aria-atomic", "true");
  } finally {
    clipboard.restore();
  }
});
