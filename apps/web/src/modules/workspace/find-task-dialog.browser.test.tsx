import type { Project, Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { FindTaskDialog } from "./find-task-dialog.tsx";

const findDialog = () => page.getByRole("dialog", { name: "Find task" });
const findOption = (name: RegExp) => findDialog().getByRole("option", { name });

const repoProject: Project = {
  id: "p1",
  name: "repo",
  path: "/repos/repo",
  defaultBaseBranch: "main",
  pinnedAt: null,
};

const settledTask = (id: string, title: string, createdAt: number): Task => ({
  id,
  projectId: repoProject.id,
  title,
  titleSource: "user",
  prompt: null,
  primarySessionId: null,
  branch: `branch-${id}`,
  workspacePath: `/work/${id}`,
  ownsWorktree: true,
  state: "settled",
  seenAt: null,
  createdAt,
});

test("a result labels the create-time branch recorded, and a detached create says no branch", async () => {
  const archived: Task = { ...settledTask("t1", "Archived work", 1), branch: "branch-audit" };
  const detached: Task = { ...settledTask("t2", "Detached work", 2), branch: "HEAD" };
  const unbranched: Task = { ...settledTask("t3", "Unbranched work", 3), branch: null };
  await render(
    <FindTaskDialog
      projects={[repoProject]}
      tasks={[archived, detached, unbranched]}
      onOpen={vi.fn<(task: Task) => void>()}
      onContinue={vi.fn<(task: Task) => Promise<void>>()}
      onClose={vi.fn<() => void>()}
    />,
  );

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

test("a failed continue keeps the dialog and its error, and a retry can still continue", async () => {
  const onContinue = vi
    .fn<(task: Task) => Promise<void>>()
    .mockRejectedValueOnce(new Error("This task no longer exists."))
    .mockResolvedValueOnce(undefined);
  const onClose = vi.fn<() => void>();
  await render(
    <FindTaskDialog
      projects={[repoProject]}
      tasks={[settledTask("t1", "Archived work", 1)]}
      onOpen={vi.fn<(task: Task) => void>()}
      onContinue={onContinue}
      onClose={onClose}
    />,
  );

  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await expect.element(page.getByRole("alert")).toMatchTextContent("This task no longer exists.");
  expect(onClose).not.toHaveBeenCalled();

  await page.getByRole("button", { name: "Continue settled task" }).click();
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(onContinue).toHaveBeenCalledTimes(2);
});

test("removing the selected task while the search is open falls back to the first remaining one", async () => {
  const beta = settledTask("t2", "Archived beta", 2);
  const alpha = settledTask("t1", "Archived alpha", 1);
  const onContinue = vi.fn<(task: Task) => Promise<void>>().mockResolvedValue(undefined);
  const props = {
    projects: [repoProject],
    onOpen: vi.fn<(task: Task) => void>(),
    onContinue,
    onClose: vi.fn<() => void>(),
  };
  const screen = await render(<FindTaskDialog {...props} tasks={[beta, alpha]} />);

  await userEvent.keyboard("{ArrowDown}");
  await expect.element(findOption(/Archived alpha/)).toHaveAttribute("aria-selected", "true");

  await screen.rerender(<FindTaskDialog {...props} tasks={[beta]} />);
  await expect.element(findOption(/Archived alpha/)).not.toBeInTheDocument();
  await expect.element(findOption(/Archived beta/)).toHaveAttribute("aria-selected", "true");

  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await vi.waitFor(() => expect(onContinue).toHaveBeenCalledExactlyOnceWith(beta));
});

test("the find-task footer stays inside the dialog instead of being clipped", async () => {
  await render(
    <FindTaskDialog
      projects={[repoProject]}
      tasks={[settledTask("t1", "Archived work", 1)]}
      onOpen={vi.fn<(task: Task) => void>()}
      onContinue={vi.fn<(task: Task) => Promise<void>>().mockResolvedValue(undefined)}
      onClose={vi.fn<() => void>()}
    />,
  );
  await expect.element(findDialog()).toBeVisible();

  const dialog = findDialog().element();
  const content = dialog.getBoundingClientRect();
  const footer = dialog.querySelector<HTMLElement>('[data-slot="dialog-footer"]');
  if (!footer) throw new Error("the find-task footer is missing");
  const box = footer.getBoundingClientRect();
  expect(box.left).toBeGreaterThanOrEqual(content.left);
  expect(box.right).toBeLessThanOrEqual(content.right);
  expect(box.bottom).toBeLessThanOrEqual(content.bottom);
});
