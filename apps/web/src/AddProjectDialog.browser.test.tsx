import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
// oxlint-disable-next-line import/no-unassigned-import -- stylesheet: a dialog is only reachable once it is positioned
import "./app.css";
import { AddProjectDialog } from "./AddProjectDialog.tsx";

const dialog = () => page.getByRole("dialog", { name: "Add project" });
const input = () => dialog().getByRole("textbox", { name: "Repository path" });

test("the path field has the focus and Enter adds the trimmed path", async () => {
  const onAdd = vi.fn<(path: string) => Promise<void>>(() => Promise.resolve());
  await render(<AddProjectDialog onAdd={onAdd} onClose={() => undefined} />);
  await expect.element(input()).toHaveFocus();

  await userEvent.keyboard("  /home/me/repo ");
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() => expect(onAdd).toHaveBeenCalledExactlyOnceWith("/home/me/repo"));
});

test("nothing is added without a path", async () => {
  const onAdd = vi.fn<(path: string) => Promise<void>>(() => Promise.resolve());
  await render(<AddProjectDialog onAdd={onAdd} onClose={() => undefined} />);
  await expect.element(input()).toHaveFocus();

  await expect.element(dialog().getByRole("button", { name: "Add project" })).toBeDisabled();
  await userEvent.keyboard("{Enter}");
  expect(onAdd).not.toHaveBeenCalled();
});

test("a failure stays in the dialog and the path can be corrected", async () => {
  const onAdd = vi
    .fn<(path: string) => Promise<void>>()
    .mockRejectedValueOnce(new Error("no such directory"))
    .mockResolvedValue(undefined);
  await render(<AddProjectDialog onAdd={onAdd} onClose={() => undefined} />);

  await expect.element(input()).toHaveFocus();
  await userEvent.keyboard("/nope{Enter}");
  await expect.element(dialog().getByRole("alert")).toMatchTextContent("no such directory");
  await expect.element(input()).toHaveValue("/nope");

  await userEvent.fill(input(), "/yes");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(onAdd).toHaveBeenLastCalledWith("/yes"));
  await expect.element(dialog().getByRole("alert")).not.toBeInTheDocument();
});

test("Escape asks to close", async () => {
  const onClose = vi.fn<() => void>();
  await render(<AddProjectDialog onAdd={() => Promise.resolve()} onClose={onClose} />);
  await expect.element(input()).toHaveFocus();

  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});
