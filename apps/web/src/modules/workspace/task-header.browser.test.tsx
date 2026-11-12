import type { SessionEntry, TaskNode } from "@corral/client/workspace-tree";
import type {
  AgentStatus,
  Project,
  PullRequest,
  Session,
  Task,
  TaskChanges,
} from "@corral/protocol/rpc";
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
  pinnedAt: null,
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

const sessionWithStatus = (status: AgentStatus): SessionEntry => {
  const session: Session = {
    id: "s1",
    taskId: "t1",
    kind: "claude",
    view: "terminal",
    agentSessionId: null,
    terminalId: "term-1",
    state: "running",
    status,
    createdAt: 0,
  };
  return { type: "session", id: session.id, session, terminal: undefined };
};

const nodeWithStatus = (
  status: AgentStatus,
  options: {
    seenAt?: number | null;
    state?: Task["state"];
    title?: string;
  } = {},
): TaskNode => ({
  task: {
    ...task("t1", "alpha-branch", options.title ?? "Status task"),
    state: options.state ?? "active",
    seenAt: options.seenAt ?? null,
  },
  sessions: [sessionWithStatus(status)],
});

const changes: TaskChanges = {
  taskId: "t1",
  base: { commit: "abc123", label: "main", fallback: null },
  files: [],
  additions: 8,
  deletions: 1,
  truncated: false,
  error: null,
};

const request: PullRequest = {
  taskId: "t1",
  provider: "github",
  host: "github.com",
  repository: "acme/alpha",
  number: 7,
  url: "https://github.com/acme/alpha/pull/7",
  title: "Show the status",
  branch: "alpha-branch",
  base: "main",
  state: "open",
  stateReason: null,
  checks: null,
  fetchedAt: 0,
};

/** The header's own status slot; absent when no session reports a status. */
const header = () => page.getByRole("group", { name: "task header" });

/** The color a theme token resolves to, read through a throwaway element. */
function tokenColor(token: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}

/**
 * The header where the workspace mounts it, with the pane width under the test's control: a task
 * switch can happen while the main area has no width yet (its first paint, a hidden pane), and the
 * branch line must follow the task anyway.
 */
function Harness({
  node,
  project: headerProject = project,
  changes: headerChanges,
  pullRequest,
  narrow,
}: {
  node?: TaskNode | undefined;
  project?: Project | undefined;
  changes?: TaskChanges | undefined;
  pullRequest?: PullRequest | undefined;
  narrow: boolean;
}) {
  return (
    <div className={narrow ? "w-0 overflow-hidden" : "w-full"}>
      <TaskHeader
        node={node}
        project={headerProject}
        changes={headerChanges}
        pullRequest={pullRequest}
        onSettle={() => {}}
        onRename={() => {}}
        onRemove={() => {}}
      />
    </div>
  );
}

const MAIN_AREA_WIDTH = {
  1024: "w-3/4",
  1920: "w-5/6",
} as const;

/** The header at the main area's width, without mounting the shell around it. */
function WidthHarness({ node, width }: { node: TaskNode; width: keyof typeof MAIN_AREA_WIDTH }) {
  return (
    <div className={MAIN_AREA_WIDTH[width]}>
      <TaskHeader
        node={node}
        project={project}
        changes={changes}
        pullRequest={request}
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
  expect(branchLine()?.textContent).toBe("alpha / alpha-branch (recorded)");

  // The switch lands while the pane is zero wide: the accessible label is fresh, so the visible
  // line must be too — the previous task's branch stayed on screen for as long as the width did.
  await screen.rerender(<Harness node={nodeOf("t2", "beta-branch", "Second task")} narrow />);
  expect(branchLine()?.getAttribute("aria-label")).toBe("alpha / beta-branch (recorded at create)");
  expect(branchLine()?.textContent).toBe("alpha / beta-branch (recorded)");
  await vi.waitFor(() => expect(branchLine()?.textContent).toBe("alpha / beta-branch (recorded)"));
});

test("a switch with a laid-out pane shows the new branch and keeps measuring", async () => {
  const screen = await render(
    <Harness node={nodeOf("t1", "alpha-branch", "First task")} narrow={false} />,
  );
  await screen.rerender(
    <Harness node={nodeOf("t2", "beta-branch", "Second task")} narrow={false} />,
  );

  await vi.waitFor(() => expect(branchLine()?.textContent).toBe("alpha / beta-branch (recorded)"));
});

test("the where segment uses the branch whether or not the task owns its worktree", async () => {
  const screen = await render(
    <Harness node={nodeOf("t1", "main", "Main task", false)} narrow={false} />,
  );
  expect(branchLine()?.textContent).toBe("alpha / main (recorded)");
  await expect.element(page.getByRole("heading", { name: "Main task" })).toBeVisible();
  expect(document.querySelector("header")?.textContent).not.toContain("›");

  await screen.rerender(
    <Harness node={nodeOf("t2", "", "Branchless task", false)} narrow={false} />,
  );
  expect(branchLine()?.textContent).toBe("alpha / detached");
  expect(branchLine()?.getAttribute("aria-label")).toBe("alpha / no branch checked out at create");
  await expect.element(page.getByRole("heading", { name: "Branchless task" })).toBeVisible();
});

test("a long project and branch truncate in the middle and keep the full context", async () => {
  const longProject = { ...project, name: "orbit-observability-platform" };
  const longBranch = "feature/header-context-with-a-long-name";
  const where = `${longProject.name} / ${longBranch} (recorded)`;
  const accessible = `${longProject.name} / ${longBranch} (recorded at create)`;
  await render(
    <Harness
      node={nodeOf("t1", longBranch, "Long context")}
      project={longProject}
      narrow={false}
    />,
  );

  await vi.waitFor(() => expect(branchLine()?.getAttribute("title")).toBe(accessible));
  expect(branchLine()?.textContent).toContain("…");
  expect(branchLine()?.getAttribute("aria-label")).toBe(accessible);
  expect(branchLine()?.getAttribute("title")).not.toBe(where);
});

test("a blocked task shows its attention word and the status AT reads from the header", async () => {
  await render(
    <Harness
      node={nodeWithStatus({
        state: "blocked",
        kind: "permission",
        message: "Run rm -rf build?",
        updatedAt: 1,
      })}
      narrow={false}
    />,
  );

  await expect.element(header().getByText("needs approval")).toBeVisible();
  const glyph = header().getByRole("img", { name: "blocked · permission" });
  await expect.element(glyph).toBeVisible();
  await expect.element(glyph).toHaveAttribute("title", "blocked · permission: Run rm -rf build?");
});

test("a working task shows only the status glyph", async () => {
  await render(
    <Harness node={nodeWithStatus({ state: "working", updatedAt: 1 })} narrow={false} />,
  );

  await expect.element(header().getByRole("img", { name: "working" })).toBeVisible();
  expect(header().element().textContent).not.toContain("working");
});

test("a seen done status stays muted and wordless, also for a settled task", async () => {
  await render(
    <Harness
      node={nodeWithStatus({ state: "done", updatedAt: 1 }, { seenAt: 2, state: "settled" })}
      narrow={false}
    />,
  );

  const glyph = header().getByRole("img", { name: "done" });
  await expect.element(glyph).toBeVisible();
  const marker = glyph.element().querySelector("[data-status]");
  expect(marker).not.toBeNull();
  expect(getComputedStyle(marker!).color).toBe(tokenColor("--muted-foreground"));
  expect(header().element().textContent).not.toContain("done");
});

test("a settled idle task keeps the sidebar's muted idle glyph and no word", async () => {
  await render(
    <Harness
      node={nodeWithStatus({ state: "idle", updatedAt: 1 }, { state: "settled" })}
      narrow={false}
    />,
  );

  const glyph = header().getByRole("img", { name: "idle" });
  await expect.element(glyph).toBeVisible();
  const marker = glyph.element().querySelector("[data-status]");
  expect(marker).not.toBeNull();
  expect(getComputedStyle(marker!).color).toBe(tokenColor("--muted-foreground"));
  expect(header().element().textContent).not.toContain("idle");
});

test("a settled task shows the sidebar's settled word beside its status, and an active task shows none", async () => {
  const screen = await render(
    <Harness
      node={nodeWithStatus({ state: "idle", updatedAt: 1 }, { state: "settled" })}
      changes={changes}
      narrow={false}
    />,
  );

  const word = header().getByText("Settled");
  await expect.element(word).toBeVisible();
  const element = word.element();
  expect(element.hasAttribute("data-task-state")).toBe(true);
  expect(element.getAttribute("data-task-state")).toBe("settled");
  expect(element.closest("[data-task-status]")).toBeNull();
  expect(header().element().querySelector("[data-task-header-actions]")?.firstElementChild).toBe(
    element,
  );
  expect(element.nextElementSibling?.textContent).toContain("8");
  expect(getComputedStyle(element).color).toBe(tokenColor("--muted-foreground"));
  expect(element.querySelector('[role="img"]')).toBeNull();
  await expect.element(header().getByRole("img", { name: "idle" })).toBeVisible();

  await screen.rerender(
    <Harness node={nodeWithStatus({ state: "idle", updatedAt: 1 })} narrow={false} />,
  );
  expect(header().element().querySelector("[data-task-state]")).toBeNull();
});

test("the draft header keeps no status, counts, badge or menu", async () => {
  await render(<Harness node={undefined} changes={changes} pullRequest={request} narrow={false} />);

  const element = header().element();
  expect(branchLine()?.textContent).toBe("alpha");
  await expect.element(header().getByRole("heading", { name: "New task" })).toBeVisible();
  expect(element.querySelector("[data-task-status]")).toBeNull();
  expect(element.querySelector("[data-task-header-actions]")).toBeNull();
  await expect
    .element(header().getByRole("button", { name: /Task menu for/ }))
    .not.toBeInTheDocument();
});

test("a task with no reported status keeps counts, badge and menu without a status slot", async () => {
  await render(
    <Harness
      node={nodeOf("t1", "alpha-branch", "Quiet task")}
      changes={changes}
      pullRequest={request}
      narrow={false}
    />,
  );

  const element = header().element();
  expect(element.querySelector("[data-task-status]")).toBeNull();
  expect(element.querySelector('[role="img"]')).toBeNull();
  await expect.element(header().getByText("+8 −1")).toBeVisible();
  await expect.element(header().getByRole("button", { name: /PR #7/ })).toBeVisible();
  await expect
    .element(header().getByRole("button", { name: "Task menu for Quiet task" }))
    .toBeVisible();
  // No width is reserved for a missing status between the badge and the menu.
  const actions = element.querySelector("[data-task-header-actions]");
  expect(actions?.children).toHaveLength(3);
});

test("the counts and request badge sit before the status instead of replacing it", async () => {
  await render(
    <Harness
      node={nodeWithStatus({
        state: "blocked",
        kind: "permission",
        message: "Run rm -rf build?",
        updatedAt: 1,
      })}
      changes={changes}
      pullRequest={request}
      narrow={false}
    />,
  );

  await expect.element(header().getByText("+8 −1")).toBeVisible();
  await expect.element(header().getByRole("button", { name: /PR #7/ })).toBeVisible();
  await expect.element(header().getByText("needs approval")).toBeVisible();
  const actions = header().element().querySelector("[data-task-header-actions]");
  expect(actions).not.toBeNull();
  expect([...actions!.children].map((child) => child.hasAttribute("data-task-status"))).toEqual([
    false,
    false,
    true,
    false,
  ]);
});

test("a long title truncates and the cluster stays inside the row at 1024 and 1920", async () => {
  // Roughly the main area beside the narrow-window sidebar, then the 1920 window's default sidebar.
  const node = nodeWithStatus(
    { state: "blocked", kind: "permission", message: "Run rm -rf build?", updatedAt: 1 },
    { title: "A task title long enough to truncate beside the whole status cluster ".repeat(6) },
  );
  const originalScale = document.documentElement.style.fontSize;
  const originalViewport = { width: window.innerWidth, height: window.innerHeight };
  const screen = await render(<WidthHarness node={node} width={1024} />);
  const assertRow = async (width: keyof typeof MAIN_AREA_WIDTH, scale: number) => {
    await page.viewport(width, width === 1024 ? 640 : 1080);
    document.documentElement.style.fontSize = `${scale}%`;
    await screen.rerender(<WidthHarness node={node} width={width} />);
    await vi.waitFor(() => {
      const element = header().element();
      if (!(element instanceof HTMLElement)) throw new Error("the task header is not an element");
      const actions = element.querySelector<HTMLElement>("[data-task-header-actions]")!;
      const title = element.querySelector("h1")!;
      const row = element.getBoundingClientRect();
      expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth);
      expect(element.scrollHeight).toBeLessThanOrEqual(element.clientHeight);
      expect(actions.getBoundingClientRect().right).toBeLessThanOrEqual(row.right);
      expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
    });
  };
  try {
    await assertRow(1024, 100);
    await assertRow(1920, 100);
    await assertRow(1024, 140);
  } finally {
    document.documentElement.style.fontSize = originalScale;
    await page.viewport(originalViewport.width, originalViewport.height);
  }
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

test("a detached create says detached and never shows or copies HEAD", async () => {
  await render(<Harness node={nodeOf("t1", "HEAD", "Detached")} narrow={false} />);

  expect(branchLine()?.textContent).toBe("alpha / detached");
  expect(branchLine()?.textContent).not.toContain("HEAD");
  expect(branchLine()?.getAttribute("aria-label")).toBe("alpha / no branch checked out at create");
  await page.getByRole("button", { name: "Task menu for Detached" }).click();
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
