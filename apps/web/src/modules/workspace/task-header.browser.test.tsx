import type { TaskNode } from "@corral/client/workspace-tree";
import type { Project, Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { TaskHeader } from "./task-header.tsx";

const project: Project = {
  id: "p1",
  name: "alpha",
  path: "/repos/alpha",
  defaultBaseBranch: "main",
};

const task = (id: string, branch: string, title: string): Task => ({
  id,
  projectId: project.id,
  title,
  titleSource: "user",
  prompt: null,
  primarySessionId: null,
  branch,
  workspacePath: `/work/${branch}`,
  ownsWorktree: true,
  state: "active",
  seenAt: null,
  createdAt: 0,
});

const nodeOf = (id: string, branch: string, title: string): TaskNode => ({
  task: task(id, branch, title),
  sessions: [],
});

/**
 * The header where the workspace mounts it, with the pane width under the test's control: a task
 * switch can happen while the main area has no width yet (its first paint, a hidden pane), and the
 * branch line must follow the task anyway (`docs/ux.md`, **Task header**).
 */
function Harness({ node, narrow }: { node: TaskNode; narrow: boolean }) {
  return (
    <div className={narrow ? "w-0 overflow-hidden" : "w-full"}>
      <TaskHeader
        node={node}
        project={project}
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
  expect(branchLine()?.textContent).toBe("alpha › alpha-branch");

  // The switch lands while the pane is zero wide: the accessible label is fresh, so the visible
  // line must be too — the previous task's branch stayed on screen for as long as the width did.
  await screen.rerender(<Harness node={nodeOf("t2", "beta-branch", "Second task")} narrow />);
  expect(branchLine()?.getAttribute("aria-label")).toBe("alpha › beta-branch");
  expect(branchLine()?.textContent).toBe("alpha › beta-branch");
  await vi.waitFor(() => expect(branchLine()?.textContent).toBe("alpha › beta-branch"));
});

test("a switch with a laid-out pane shows the new branch and keeps measuring", async () => {
  const screen = await render(
    <Harness node={nodeOf("t1", "alpha-branch", "First task")} narrow={false} />,
  );
  await screen.rerender(
    <Harness node={nodeOf("t2", "beta-branch", "Second task")} narrow={false} />,
  );

  await vi.waitFor(() => expect(branchLine()?.textContent).toBe("alpha › beta-branch"));
});
