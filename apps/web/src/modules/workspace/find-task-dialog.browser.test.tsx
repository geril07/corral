import type { Project, Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { FindTaskDialog } from "./find-task-dialog.tsx";

const findDialog = () => page.getByRole("dialog", { name: "Find task" });
const searchInput = () => findDialog().getByRole("combobox", { name: "Tasks" });
const findOption = (name: RegExp) => findDialog().getByRole("option", { name });
/**
 * The dialog's layout height, for the checks that results never resize it: `offsetHeight` ignores
 * the enter animation's scale, which a bounding box would report mid-flight.
 */
const dialogHeight = () => {
  const dialog = findDialog().element();
  if (!(dialog instanceof HTMLElement)) throw new Error("the finder is not an element");
  return dialog.offsetHeight;
};

const repoProject: Project = {
  id: "p1",
  name: "repo",
  path: "/repos/repo",
  defaultBaseBranch: "main",
  pinnedAt: null,
};

const task = (
  id: string,
  title: string,
  options: {
    projectId?: string | null;
    state?: Task["state"];
    createdAt?: number;
  } = {},
): Task => ({
  id,
  projectId: options.projectId === undefined ? repoProject.id : options.projectId,
  title,
  titleSource: "user",
  prompt: null,
  primarySessionId: null,
  branch: `branch-${id}`,
  workspacePath: `/work/${id}`,
  ownsWorktree: true,
  state: options.state ?? "active",
  seenAt: null,
  createdAt: options.createdAt ?? 0,
});

function props(tasks: readonly Task[], onOpen = vi.fn<(task: Task) => void>()) {
  return {
    projects: [repoProject],
    tasks,
    onOpen,
    onClose: vi.fn<() => void>(),
  };
}

test("opening focuses one search field over one grouped list, with no title, description or footer", async () => {
  await render(<FindTaskDialog {...props([task("t1", "Fix login"), task("t2", "Write docs")])} />);

  await expect.element(searchInput()).toHaveFocus();
  // The sr-only title still names the dialog for assistive tech; nothing of it is in the box.
  expect(findDialog().element().textContent).not.toContain("Find task");
  expect(document.querySelectorAll('[data-slot="dialog-description"]')).toHaveLength(0);
  expect(findDialog().element().querySelectorAll('[data-slot="dialog-footer"]')).toHaveLength(0);
  expect(findDialog().getByRole("button").elements()).toHaveLength(0);

  // One list under one heading, and the first row is the selection Enter acts on.
  await expect.element(findDialog().getByRole("group", { name: "Tasks" })).toBeVisible();
  await expect.element(findOption(/Fix login/)).toHaveAttribute("aria-selected", "true");
  await expect.element(findOption(/Write docs/)).toHaveAttribute("aria-selected", "false");
});

test("typing filters the list and Enter opens the highlighted task", async () => {
  const onOpen = vi.fn<(task: Task) => void>();
  const propsFor = props([task("t1", "Fix login"), task("t2", "Write docs")], onOpen);
  await render(<FindTaskDialog {...propsFor} />);

  await userEvent.keyboard("docs");
  await expect.element(findOption(/Write docs/)).toBeVisible();
  await expect.element(findOption(/Fix login/)).not.toBeInTheDocument();

  await userEvent.keyboard("{Enter}");
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "t2" }));
  await vi.waitFor(() => expect(propsFor.onClose).toHaveBeenCalledOnce());
});

test("Arrow keys move the selection and wrap, and Escape closes without opening", async () => {
  const onOpen = vi.fn<(task: Task) => void>();
  const propsFor = props(
    [task("t1", "Fix login", { createdAt: 3 }), task("t2", "Write docs", { createdAt: 2 })],
    onOpen,
  );
  await render(<FindTaskDialog {...propsFor} />);

  await expect.element(findOption(/Fix login/)).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(findOption(/Write docs/)).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(findOption(/Fix login/)).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{ArrowUp}");
  await expect.element(findOption(/Write docs/)).toHaveAttribute("aria-selected", "true");

  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(propsFor.onClose).toHaveBeenCalledOnce());
  expect(onOpen).not.toHaveBeenCalled();
});

test("a scratch task joins the same list as No project and opens with Enter", async () => {
  const scratch = task("t1", "Scratch notes", { projectId: null, createdAt: 2 });
  const onOpen = vi.fn<(task: Task) => void>();
  const propsFor = props([scratch, task("t2", "Project work", { createdAt: 1 })], onOpen);
  await render(<FindTaskDialog {...propsFor} />);

  await expect.element(findOption(/Scratch notes/)).toMatchTextContent(/No project/);
  await expect.element(findOption(/Project work/)).toMatchTextContent(/repo/);

  await userEvent.keyboard("scratch");
  await userEvent.keyboard("{Enter}");
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(scratch);
  await vi.waitFor(() => expect(propsFor.onClose).toHaveBeenCalledOnce());
});

test("a settled row opens with Enter and offers no Continue action", async () => {
  const settled = task("t1", "Old work", { state: "settled" });
  const onOpen = vi.fn<(task: Task) => void>();
  const propsFor = props([settled], onOpen);
  await render(<FindTaskDialog {...propsFor} />);

  await expect.element(findOption(/Old work/)).toMatchTextContent(/settled/);
  expect(findDialog().element().textContent).not.toContain("Continue");

  await userEvent.keyboard("{Enter}");
  // Opening a settled task leaves its state alone; starting work is what un-shelves it (#277).
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(settled);
  await vi.waitFor(() => expect(propsFor.onClose).toHaveBeenCalledOnce());
});

test("the empty state is one line and the dialog keeps its height as results change", async () => {
  const { unmount } = await render(
    <FindTaskDialog {...props([task("t1", "Fix login"), task("t2", "Write docs")])} />,
  );
  await expect.element(findOption(/Fix login/)).toBeVisible();
  const browsing = dialogHeight();
  expect(browsing).toBeGreaterThan(0);

  await userEvent.keyboard("docs");
  await expect.element(findOption(/Write docs/)).toBeVisible();
  expect(dialogHeight()).toBe(browsing);

  await userEvent.keyboard("zz");
  await expect.element(findDialog().getByText("No results found")).toBeVisible();
  expect(dialogHeight()).toBe(browsing);
  await unmount();

  // A finder with nothing watched says the same one line at the same size.
  await render(<FindTaskDialog {...props([])} />);
  await expect.element(findDialog().getByText("No results found")).toBeVisible();
  expect(dialogHeight()).toBe(browsing);
});

test("a result labels the create-time branch recorded, and a detached create says no branch", async () => {
  const archived: Task = { ...task("t1", "Archived work"), branch: "branch-audit" };
  const detached: Task = { ...task("t2", "Detached work"), branch: "HEAD" };
  const unbranched: Task = { ...task("t3", "Unbranched work"), branch: null };
  await render(<FindTaskDialog {...props([archived, detached, unbranched])} />);

  const recorded = findOption(/Archived work/);
  await expect.element(recorded).toMatchTextContent(/branch-audit\s*\(recorded\)/);
  expect(recorded.element().getAttribute("aria-label")).toContain(
    "branch-audit (recorded at create)",
  );

  // A 1/3-width branch column at the 384 px dialog truncated the old combined label to
  // "branch-audit (re…"; the reflowed name and qualifier have to stay whole at 1024.
  const branchName = recorded.element().querySelector("[data-recorded-name]");
  if (!(branchName instanceof HTMLElement)) throw new Error("the branch has no name");
  expect(branchName.textContent).toBe("branch-audit");
  expect(branchName.scrollWidth).toBeLessThanOrEqual(branchName.clientWidth + 1);
  const qualifier = recorded.element().querySelector("[data-recorded-qualifier]");
  if (!(qualifier instanceof HTMLElement)) throw new Error("the branch has no recorded qualifier");
  expect(qualifier.textContent).toBe("(recorded)");
  expect(qualifier.scrollWidth).toBeLessThanOrEqual(qualifier.clientWidth + 1);
  const option = recorded.element().getBoundingClientRect();
  for (const label of [branchName, qualifier]) {
    const rect = label.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.right).toBeLessThanOrEqual(option.right + 1);
  }

  const detachedOption = findOption(/Detached work/);
  await expect.element(detachedOption).toMatchTextContent("no branch");
  await expect.element(detachedOption).not.toMatchTextContent("HEAD");

  // A task created without a branch must not disappear from the finder.
  const unbranchedOption = findOption(/Unbranched work/);
  await expect.element(unbranchedOption).toMatchTextContent("no branch");
  expect(unbranchedOption.element().getAttribute("aria-label")).toContain(
    "no branch checked out at create",
  );
});

test("removing the selected task while the search is open falls back to the first remaining one", async () => {
  const beta = task("t2", "Archived beta", { createdAt: 2 });
  const alpha = task("t1", "Archived alpha", { createdAt: 1 });
  const onOpen = vi.fn<(task: Task) => void>();
  const onClose = vi.fn<() => void>();
  const screen = await render(
    <FindTaskDialog {...props([beta, alpha], onOpen)} onClose={onClose} />,
  );

  await userEvent.keyboard("{ArrowDown}");
  await expect.element(findOption(/Archived alpha/)).toHaveAttribute("aria-selected", "true");

  await screen.rerender(<FindTaskDialog {...props([beta], onOpen)} onClose={onClose} />);
  await expect.element(findOption(/Archived alpha/)).not.toBeInTheDocument();
  await expect.element(findOption(/Archived beta/)).toHaveAttribute("aria-selected", "true");

  await userEvent.keyboard("{Enter}");
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(beta);
});
