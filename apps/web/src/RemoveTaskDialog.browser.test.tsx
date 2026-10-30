import { ORPCError } from "@orpc/client";
import type { Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
// oxlint-disable-next-line import/no-unassigned-import -- stylesheet: a dialog is only reachable once it is positioned
import "./app.css";
import { RemoveTaskDialog } from "./RemoveTaskDialog.tsx";

const task: Task = {
  id: "t1",
  projectId: "p1",
  title: "Fix login",
  branch: "fix-login",
  workspacePath: "/data/worktrees/repo/fix-login",
  ownsWorktree: true,
  state: "active",
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
  await expect.element(dialog()).toMatchTextContent("fix-login stays");
  await expect.element(dialog()).toMatchTextContent("Stops its sessions");
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

test("a task in the main working tree says the working tree stays", async () => {
  await render(
    <RemoveTaskDialog
      task={{ ...task, ownsWorktree: false }}
      onRemove={() => Promise.resolve()}
      onClose={() => undefined}
    />,
  );

  await expect.element(dialog()).toMatchTextContent("working tree");
  await expect.element(dialog()).not.toMatchTextContent("removes the worktree");
});

test("uncommitted changes are listed and removing needs a second, explicit step with the focus back on Cancel", async () => {
  const onRemove = vi
    .fn<(force: boolean) => Promise<void>>()
    .mockRejectedValueOnce(dirty(["notes.txt", "src/new.ts"]))
    .mockResolvedValue(undefined);
  await render(<RemoveTaskDialog task={task} onRemove={onRemove} onClose={() => undefined} />);

  await opened();
  await userEvent.keyboard("{Tab}{Enter}");
  const files = dialog().getByRole("list", { name: "uncommitted files" });
  await expect.element(files).toMatchTextContent("notes.txt");
  await expect.element(files).toMatchTextContent("src/new.ts");
  await expect.element(button("Remove anyway")).toBeVisible();
  await expect.element(button("Cancel")).toHaveFocus();

  // The Enter that confirmed the first step must not confirm the second.
  await userEvent.keyboard("{Enter}");
  expect(onRemove).toHaveBeenCalledTimes(1);
});

test("Remove anyway forces", async () => {
  const onRemove = vi
    .fn<(force: boolean) => Promise<void>>()
    .mockRejectedValueOnce(dirty(["notes.txt"]))
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
