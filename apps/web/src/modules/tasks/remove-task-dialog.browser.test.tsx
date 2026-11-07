import { ORPCError } from "@orpc/client";
import type { Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { RemoveTaskDialog } from "./remove-task-dialog.tsx";

const task: Task = {
  id: "t1",
  projectId: "p1",
  title: "Fix login",
  titleSource: "user",
  prompt: null,
  primarySessionId: null,
  branch: "fix-login",
  workspacePath: "/data/worktrees/repo/fix-login",
  ownsWorktree: true,
  state: "active",
  seenAt: null,
  createdAt: 0,
};

const dialog = () => page.getByRole("alertdialog");
const button = (name: string) => dialog().getByRole("button", { name });
// Keys typed before the dialog has taken the focus would go to the page behind it.
const opened = async () => {
  await expect.element(button("Cancel")).toHaveFocus();
};

// What the client makes of the server's typed error (see rpc-errors.ts).
const dirty = (files: string[]) =>
  new ORPCError("WORKTREE_DIRTY", { defined: true, data: { files } });

test("it says what removing does and starts on Cancel, so a stray Enter removes nothing", async () => {
  const onRemove = vi.fn<(force: boolean) => Promise<void>>(() => Promise.resolve());
  const onClose = vi.fn<() => void>();
  await render(<RemoveTaskDialog task={task} onRemove={onRemove} onClose={onClose} />);

  await expect.element(dialog()).toMatchTextContent("/data/worktrees/repo/fix-login");
  await expect
    .element(dialog())
    .toMatchTextContent("The branch checked out in the worktree stays.");
  await expect.element(dialog()).not.toMatchTextContent("The branch fix-login stays.");
  await expect.element(dialog()).toMatchTextContent("Stops its sessions");
  // A loose terminal is not a session; the copy names what the sweep closes.
  await expect.element(dialog()).toMatchTextContent("closes the terminals in the workspace");
  await expect.element(dialog()).toMatchTextContent("including loose ones");
  await expect.element(button("Cancel")).toHaveFocus();

  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(onRemove).not.toHaveBeenCalled();
});

test("Tab then Enter removes without force", async () => {
  const onRemove = vi.fn<(force: boolean) => Promise<void>>(() => Promise.resolve());
  await render(<RemoveTaskDialog task={task} onRemove={onRemove} onClose={() => undefined} />);

  await opened();
  await userEvent.keyboard("{Tab}{Enter}");

  await vi.waitFor(() => expect(onRemove).toHaveBeenCalledExactlyOnceWith(false));
});

test("a workspace directory that is already gone is named, and the copy says what removal does then", async () => {
  const onRemove = vi.fn<(force: boolean) => Promise<void>>(() => Promise.resolve());
  await render(
    <RemoveTaskDialog task={task} workspaceMissing onRemove={onRemove} onClose={() => undefined} />,
  );

  await expect.element(dialog()).toMatchTextContent("already gone");
  await expect.element(dialog()).toMatchTextContent(task.workspacePath);
  await expect.element(dialog()).toMatchTextContent("prunes the stale git worktree entry");
  await expect.element(dialog()).toMatchTextContent("keeps the branch");
  await expect.element(dialog()).not.toMatchTextContent(`keeps the branch ${task.branch}`);
  // The ordinary promise to remove the worktree would be false here.
  await expect.element(dialog()).not.toMatchTextContent("removes the worktree at");
  await expect.element(button("Cancel")).toHaveFocus();
});

test("the live branch is named and the recorded one is never promised", async () => {
  await render(
    <RemoveTaskDialog
      task={{ ...task, branch: "recorded-branch" }}
      loadLiveBranch={() => Promise.resolve("renamed-branch")}
      onRemove={() => Promise.resolve()}
      onClose={() => undefined}
    />,
  );

  await expect.element(dialog()).toMatchTextContent("The branch renamed-branch stays.");
  await expect.element(dialog()).not.toMatchTextContent("The branch recorded-branch stays.");
});

test("while the live read is pending the copy stays generic, then names the answer", async () => {
  let release!: (branch: string | null) => void;
  const load = vi.fn<() => Promise<string | null>>(
    () =>
      new Promise<string | null>((resolve) => {
        release = resolve;
      }),
  );
  await render(
    <RemoveTaskDialog
      task={{ ...task, branch: "recorded-branch" }}
      loadLiveBranch={load}
      onRemove={() => Promise.resolve()}
      onClose={() => undefined}
    />,
  );

  await expect
    .element(dialog())
    .toMatchTextContent("The branch checked out in the worktree stays.");
  await expect.element(dialog()).not.toMatchTextContent("The branch recorded-branch stays.");

  release("live-branch");
  await expect.element(dialog()).toMatchTextContent("The branch live-branch stays.");
  expect(load).toHaveBeenCalledOnce();
});

test("a rejected live read keeps the generic promise, and a detached live read says no branch", async () => {
  const screen = await render(
    <RemoveTaskDialog
      task={{ ...task, branch: "recorded-branch" }}
      loadLiveBranch={() => Promise.reject(new Error("workspace unreadable"))}
      onRemove={() => Promise.resolve()}
      onClose={() => undefined}
    />,
  );

  await expect
    .element(dialog())
    .toMatchTextContent("The branch checked out in the worktree stays.");
  await expect.element(dialog()).not.toMatchTextContent("The branch recorded-branch stays.");

  await screen.rerender(
    <RemoveTaskDialog
      task={{ ...task, id: "t2", branch: "recorded-branch" }}
      loadLiveBranch={() => Promise.resolve(null)}
      onRemove={() => Promise.resolve()}
      onClose={() => undefined}
    />,
  );
  await expect
    .element(dialog())
    .toMatchTextContent("No branch is checked out in the worktree; branches are not deleted.");
});

test("a task in the main working tree never reads a live branch", async () => {
  const load = vi.fn<() => Promise<string | null>>(() => Promise.resolve("live-branch"));
  await render(
    <RemoveTaskDialog
      task={{ ...task, ownsWorktree: false }}
      loadLiveBranch={load}
      onRemove={() => Promise.resolve()}
      onClose={() => undefined}
    />,
  );

  await expect.element(dialog()).toMatchTextContent("working tree stays; branches are not deleted");
  await expect.element(dialog()).not.toMatchTextContent("removes the worktree");
  // The project's main tree is not the task's: its loose terminals are not swept.
  await expect.element(dialog()).not.toMatchTextContent("including loose ones");
  expect(load).not.toHaveBeenCalled();
});

test("ignored entries are listed as local changes and removing needs a second, explicit step with the focus back on Cancel", async () => {
  const onRemove = vi
    .fn<(force: boolean) => Promise<void>>()
    .mockRejectedValueOnce(dirty([".env", "node_modules/"]))
    .mockResolvedValue(undefined);
  await render(<RemoveTaskDialog task={task} onRemove={onRemove} onClose={() => undefined} />);

  await opened();
  await userEvent.keyboard("{Tab}{Enter}");
  const files = dialog().getByRole("list", { name: "local changes" });
  await expect.element(files).toMatchTextContent(".env");
  await expect.element(files).toMatchTextContent("node_modules/");
  await expect
    .element(dialog().getByRole("alert"))
    .toMatchTextContent("local changes, including ignored files");
  await expect.element(button("Remove anyway")).toBeVisible();
  await expect.element(button("Cancel")).toHaveFocus();

  // The Enter that confirmed the first step must not confirm the second.
  await userEvent.keyboard("{Enter}");
  expect(onRemove).toHaveBeenCalledTimes(1);
});

test("Remove anyway forces", async () => {
  const onRemove = vi
    .fn<(force: boolean) => Promise<void>>()
    .mockRejectedValueOnce(dirty([".env", "node_modules/"]))
    .mockResolvedValue(undefined);
  await render(<RemoveTaskDialog task={task} onRemove={onRemove} onClose={() => undefined} />);

  await opened();
  await userEvent.keyboard("{Tab}{Enter}");
  await button("Remove anyway").click();

  await vi.waitFor(() => expect(onRemove).toHaveBeenLastCalledWith(true));
});

test("another failure is shown as it is, with the plain Remove still on offer", async () => {
  const onRemove = vi.fn<(force: boolean) => Promise<void>>(() =>
    Promise.reject(
      new ORPCError("GIT_FAILED", { defined: true, data: { message: "fatal: locked" } }),
    ),
  );
  await render(<RemoveTaskDialog task={task} onRemove={onRemove} onClose={() => undefined} />);

  await opened();
  await userEvent.keyboard("{Tab}{Enter}");

  await expect.element(dialog().getByRole("alert")).toMatchTextContent("fatal: locked");
  await expect.element(button("Remove task")).toBeVisible();
  await expect.element(button("Remove anyway")).not.toBeInTheDocument();
});

test("a long worktree path wraps inside the dialog instead of overflowing it", async () => {
  const longPath = `/${"x".repeat(180)}`;
  await render(
    <RemoveTaskDialog
      task={{ ...task, workspacePath: longPath, branch: "fix/login-with-a-long-branch-name" }}
      onRemove={() => Promise.resolve()}
      onClose={() => undefined}
    />,
  );
  const surface = dialog().element();
  await vi.waitFor(() => expect(surface.scrollWidth).toBeLessThanOrEqual(surface.clientWidth + 1));
  const remove = button("Remove task").element();
  expect(remove.getBoundingClientRect().right).toBeLessThanOrEqual(
    surface.getBoundingClientRect().right + 1,
  );
});
