import { ORPCError } from "@orpc/client";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { RenameDialog, type RenameTarget } from "./rename-dialog.tsx";

const target: RenameTarget = {
  type: "session",
  id: "s1",
  name: "shell 2",
  value: "",
};

const dialog = () => page.getByRole("dialog", { name: "Rename shell 2" });
const name = () => dialog().getByRole("textbox", { name: "Name" });

test("the name field starts focused with the current label, and Enter saves the trimmed name", async () => {
  const onSave = vi.fn<(name: string | null) => Promise<void>>(() => Promise.resolve());
  const onClose = vi.fn<() => void>();
  await render(
    <RenameDialog target={{ ...target, value: "old" }} onSave={onSave} onClose={onClose} />,
  );

  await expect.element(name()).toHaveFocus();
  await expect.element(name()).toHaveValue("old");
  await userEvent.fill(name(), "  build  ");
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() => expect(onSave).toHaveBeenCalledExactlyOnceWith("build"));
  expect(onClose).not.toHaveBeenCalled();
});

test("an empty name saves nothing, so the natural name comes back", async () => {
  const onSave = vi.fn<(name: string | null) => Promise<void>>(() => Promise.resolve());
  await render(
    <RenameDialog target={{ ...target, value: "old" }} onSave={onSave} onClose={() => undefined} />,
  );

  await userEvent.fill(name(), "   ");
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() => expect(onSave).toHaveBeenCalledExactlyOnceWith(null));
});

test("Escape cancels without saving", async () => {
  const onSave = vi.fn<(name: string | null) => Promise<void>>(() => Promise.resolve());
  const onClose = vi.fn<() => void>();
  await render(<RenameDialog target={target} onSave={onSave} onClose={onClose} />);

  await userEvent.fill(name(), "build");
  await userEvent.keyboard("{Escape}");

  await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(onSave).not.toHaveBeenCalled();
});

test("a name that cannot be used is refused in the dialog, which stays open for another try", async () => {
  const onSave = vi.fn<(name: string | null) => Promise<void>>(() => Promise.resolve());
  const onClose = vi.fn<() => void>();
  await render(<RenameDialog target={target} onSave={onSave} onClose={onClose} />);

  await userEvent.fill(name(), "x".repeat(81));
  await userEvent.keyboard("{Enter}");

  await expect.element(dialog().getByRole("alert")).toMatchTextContent("at most 80 characters");
  expect(onSave).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();

  await userEvent.fill(name(), "build");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(onSave).toHaveBeenLastCalledWith("build"));
});

test("a refusal from the server shows in the dialog, which stays open", async () => {
  const onSave = vi
    .fn<(name: string | null) => Promise<void>>()
    .mockRejectedValueOnce(
      new ORPCError("SESSION_NOT_FOUND", { defined: true, data: { id: "s1" } }),
    )
    .mockResolvedValue(undefined);
  const onClose = vi.fn<() => void>();
  await render(<RenameDialog target={target} onSave={onSave} onClose={onClose} />);

  await userEvent.fill(name(), "build");
  await userEvent.keyboard("{Enter}");

  await expect.element(dialog().getByRole("alert")).toMatchTextContent("no longer exists");
  expect(onClose).not.toHaveBeenCalled();
});

test("the dialog says what a rename does not change and how long the name lasts", async () => {
  const first = await render(
    <RenameDialog target={target} onSave={() => Promise.resolve()} onClose={() => undefined} />,
  );
  await expect.element(dialog()).toMatchTextContent("conversation stay");
  await expect.element(dialog()).toMatchTextContent("through restarts");
  await first.unmount();

  await render(
    <RenameDialog
      target={{ type: "terminal", id: "t1", name: "sh · work", value: "" }}
      onSave={() => Promise.resolve()}
      onClose={() => undefined}
    />,
  );
  await expect
    .element(page.getByRole("dialog", { name: "Rename sh · work" }))
    .toMatchTextContent("ends with the server");
});

test("a task is renamed by its title, which cannot be emptied, and a server refusal keeps the dialog open", async () => {
  const task: RenameTarget = {
    type: "task",
    id: "t1",
    name: "Fix the login bug",
    value: "Fix the login bug",
  };
  const onSave = vi
    .fn<(name: string | null) => Promise<void>>()
    .mockRejectedValueOnce(new ORPCError("TASK_NOT_FOUND", { defined: true, data: { id: "t1" } }))
    .mockResolvedValue(undefined);
  const onClose = vi.fn<() => void>();
  await render(<RenameDialog target={task} onSave={onSave} onClose={onClose} />);

  const title = page
    .getByRole("dialog", { name: "Rename Fix the login bug" })
    .getByRole("textbox", { name: "Title" });
  await expect.element(title).toHaveFocus();
  await expect.element(title).toHaveValue("Fix the login bug");
  await expect
    .element(page.getByRole("dialog", { name: "Rename Fix the login bug" }))
    .toMatchTextContent("branch and the worktree keep their names");

  await userEvent.fill(title, "   ");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByRole("dialog", { name: "Rename Fix the login bug" }).getByRole("alert"))
    .toMatchTextContent("A task needs a title.");
  expect(onSave).not.toHaveBeenCalled();

  await userEvent.fill(title, "  Login fails on Safari  ");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByRole("dialog", { name: "Rename Fix the login bug" }).getByRole("alert"))
    .toMatchTextContent("no longer exists");
  expect(onSave).toHaveBeenCalledExactlyOnceWith("Login fails on Safari");
  expect(onClose).not.toHaveBeenCalled();
});
