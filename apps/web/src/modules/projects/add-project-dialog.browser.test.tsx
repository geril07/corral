import { ORPCError } from "@orpc/client";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { AddProjectDialog } from "./add-project-dialog.tsx";

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

test("the server's path refusals stay in the dialog, and Escape still closes it", async () => {
  const onAdd = vi
    .fn<(path: string) => Promise<void>>()
    .mockRejectedValueOnce(
      new ORPCError("GIT_FAILED", {
        defined: true,
        data: { message: "no such directory: /home/me/missing" },
      }),
    )
    .mockRejectedValueOnce(
      new ORPCError("GIT_FAILED", {
        defined: true,
        data: { message: "the project path must be an absolute path or start with ~/" },
      }),
    )
    .mockRejectedValueOnce(
      new ORPCError("NOT_A_GIT_REPOSITORY", { defined: true, data: { path: "/home/me" } }),
    );
  const onClose = vi.fn<() => void>();
  await render(<AddProjectDialog onAdd={onAdd} onClose={onClose} />);

  await expect.element(input()).toHaveFocus();
  await userEvent.keyboard("~/missing{Enter}");
  await expect
    .element(dialog().getByRole("alert"))
    .toMatchTextContent("no such directory: /home/me/missing");

  await userEvent.fill(input(), "relative/repo");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(dialog().getByRole("alert"))
    .toMatchTextContent("the project path must be an absolute path or start with ~/");

  await userEvent.fill(input(), "~/");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(dialog().getByRole("alert"))
    .toMatchTextContent("/home/me is not inside a git repository.");
  await expect.element(input()).toHaveFocus();

  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});

test("Escape asks to close", async () => {
  const onClose = vi.fn<() => void>();
  await render(<AddProjectDialog onAdd={() => Promise.resolve()} onClose={onClose} />);
  await expect.element(input()).toHaveFocus();

  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});
