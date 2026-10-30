import { ORPCError } from "@orpc/client";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { RenameEntryDialog, type RenameTarget } from "./rename-entry-dialog.tsx";

const target: RenameTarget = {
  type: "session",
  id: "s1",
  name: "shell 2",
  label: null,
};

const dialog = () => page.getByRole("dialog", { name: "Rename shell 2" });
const name = () => dialog().getByRole("textbox", { name: "Name" });

test("the name field starts focused with the current label, and Enter saves the trimmed name", async () => {
  const onSave = vi.fn<(label: string | null) => Promise<void>>(() => Promise.resolve());
  const onClose = vi.fn<() => void>();
  await render(
    <RenameEntryDialog target={{ ...target, label: "old" }} onSave={onSave} onClose={onClose} />,
  );

  await expect.element(name()).toHaveFocus();
  await expect.element(name()).toHaveValue("old");
  await userEvent.fill(name(), "  build  ");
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() => expect(onSave).toHaveBeenCalledExactlyOnceWith("build"));
  expect(onClose).not.toHaveBeenCalled();
});

test("an empty name saves nothing, so the natural name comes back", async () => {
  const onSave = vi.fn<(label: string | null) => Promise<void>>(() => Promise.resolve());
  await render(
    <RenameEntryDialog
      target={{ ...target, label: "old" }}
      onSave={onSave}
      onClose={() => undefined}
    />,
  );

  await userEvent.fill(name(), "   ");
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() => expect(onSave).toHaveBeenCalledExactlyOnceWith(null));
});

test("Escape cancels without saving", async () => {
  const onSave = vi.fn<(label: string | null) => Promise<void>>(() => Promise.resolve());
  const onClose = vi.fn<() => void>();
  await render(<RenameEntryDialog target={target} onSave={onSave} onClose={onClose} />);

  await userEvent.fill(name(), "build");
  await userEvent.keyboard("{Escape}");

  await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(onSave).not.toHaveBeenCalled();
});

test("a name that cannot be used is refused in the dialog, which stays open for another try", async () => {
  const onSave = vi.fn<(label: string | null) => Promise<void>>(() => Promise.resolve());
  const onClose = vi.fn<() => void>();
  await render(<RenameEntryDialog target={target} onSave={onSave} onClose={onClose} />);

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
    .fn<(label: string | null) => Promise<void>>()
    .mockRejectedValueOnce(
      new ORPCError("SESSION_NOT_FOUND", { defined: true, data: { id: "s1" } }),
    )
    .mockResolvedValue(undefined);
  const onClose = vi.fn<() => void>();
  await render(<RenameEntryDialog target={target} onSave={onSave} onClose={onClose} />);

  await userEvent.fill(name(), "build");
  await userEvent.keyboard("{Enter}");

  await expect.element(dialog().getByRole("alert")).toMatchTextContent("no longer exists");
  expect(onClose).not.toHaveBeenCalled();
});

test("the dialog says what a rename does not change and how long the name lasts", async () => {
  const first = await render(
    <RenameEntryDialog
      target={target}
      onSave={() => Promise.resolve()}
      onClose={() => undefined}
    />,
  );
  await expect.element(dialog()).toMatchTextContent("conversation stay");
  await expect.element(dialog()).toMatchTextContent("through restarts");
  await first.unmount();

  await render(
    <RenameEntryDialog
      target={{ type: "terminal", id: "t1", name: "sh · work", label: null }}
      onSave={() => Promise.resolve()}
      onClose={() => undefined}
    />,
  );
  await expect
    .element(page.getByRole("dialog", { name: "Rename sh · work" }))
    .toMatchTextContent("ends with the server");
});
