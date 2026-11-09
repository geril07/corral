import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { AddProjectDialog } from "./add-project-dialog.tsx";

const input = () => page.getByRole("combobox", { name: "Repository path" });
const entries = [
  { name: "alpha", path: "/parent/alpha/" },
  { name: "alpine", path: "/parent/alpine/" },
];
const browse = () => Promise.resolve({ directories: entries, truncated: false });

test("path first, no automatic selection; exact Enter submits input", async () => {
  const add = vi.fn<(path: string) => Promise<void>>(() => Promise.resolve());
  await render(<AddProjectDialog onAdd={add} onBrowse={browse} onClose={() => undefined} />);
  await expect.element(input()).toHaveFocus();
  await expect.element(input()).toHaveValue("~/");
  await expect
    .element(page.getByRole("button", { name: "Add project (Enter)", exact: true }))
    .toBeVisible();
  await userEvent.fill(input(), "/parent");
  await expect.element(page.getByRole("option", { name: "alpha", exact: true })).toBeVisible();
  await expect.element(input()).not.toHaveAttribute("aria-activedescendant");
  await userEvent.keyboard("{Enter}");
  expect(add).toHaveBeenCalledExactlyOnceWith("/parent");
});

test("arrows and Ctrl N/P highlight, Enter navigates, Ctrl Enter adds input", async () => {
  const add = vi.fn<(path: string) => Promise<void>>(() => Promise.resolve());
  await render(<AddProjectDialog onAdd={add} onBrowse={browse} onClose={() => undefined} />);
  await userEvent.fill(input(), "/parent/");
  await expect.element(page.getByRole("option", { name: "alpha", exact: true })).toBeVisible();
  await userEvent.keyboard("{ArrowDown}");
  await expect
    .element(page.getByRole("button", { name: "Add project (Ctrl+Enter)", exact: true }))
    .toBeVisible();
  await userEvent.keyboard("{Enter}");
  await expect.element(input()).toHaveValue("/parent/alpha/");
  await expect
    .element(page.getByRole("button", { name: "Add project (Enter)", exact: true }))
    .toBeVisible();
  expect(add).not.toHaveBeenCalled();
  await userEvent.fill(input(), "/parent/");
  await expect.element(page.getByRole("option", { name: "alpha", exact: true })).toBeVisible();
  await userEvent.keyboard("{Control>}n{/Control}{Control>}{Enter}{/Control}");
  expect(add).toHaveBeenCalledExactlyOnceWith("/parent/");
});

test("trailing Add submits the input, not the highlighted folder, and keeps focus on failure", async () => {
  const add = vi.fn<(path: string) => Promise<void>>(() =>
    Promise.reject(new Error("Already added")),
  );
  await render(<AddProjectDialog onAdd={add} onBrowse={browse} onClose={() => undefined} />);
  await userEvent.fill(input(), "/parent/");
  await expect.element(page.getByRole("option", { name: "alpha", exact: true })).toBeVisible();
  await userEvent.keyboard("{Control>}n{/Control}");
  await page.getByRole("button", { name: "Add project (Ctrl+Enter)", exact: true }).click();
  expect(add).toHaveBeenCalledExactlyOnceWith("/parent/");
  await expect.element(page.getByText("Already added", { exact: true })).toBeVisible();
  await expect.element(input()).toHaveValue("/parent/");
  await expect.element(input()).toHaveFocus();
  await userEvent.fill(input(), "/edited/");
  await expect
    .element(page.getByRole("button", { name: "Add project (Enter)", exact: true }))
    .toBeVisible();
});

test("Tab common prefix and pointer navigation", async () => {
  await render(
    <AddProjectDialog
      onAdd={() => Promise.resolve()}
      onBrowse={browse}
      onClose={() => undefined}
    />,
  );
  await userEvent.fill(input(), "/parent/a");
  await expect.element(page.getByRole("option", { name: "alpha", exact: true })).toBeVisible();
  await userEvent.keyboard("{Tab}");
  await expect.element(input()).toHaveValue("/parent/alp");
  await page.getByRole("option", { name: "alpha", exact: true }).click();
  await expect.element(input()).toHaveValue("/parent/alpha/");
});

test("pending add is guarded; failure keeps path with a toast; Escape closes", async () => {
  let reject!: (error: Error) => void;
  const add = vi.fn<(path: string) => Promise<void>>(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  );
  const close = vi.fn<() => void>();
  await render(<AddProjectDialog onAdd={add} onBrowse={browse} onClose={close} />);
  await userEvent.fill(input(), "/missing");
  await userEvent.keyboard("{Enter}{Enter}");
  expect(add).toHaveBeenCalledTimes(1);
  await expect.element(page.getByRole("button", { name: /Add project/ })).toBeDisabled();
  reject(new Error("no such directory"));
  await expect.element(page.getByText("no such directory", { exact: true })).toBeVisible();
  await expect.element(input()).toHaveValue("/missing");
  await userEvent.keyboard("{Escape}");
  expect(close).toHaveBeenCalledTimes(1);
});

test("old asynchronous results cannot replace a newer path", async () => {
  let old!: (result: { directories: typeof entries; truncated: boolean }) => void;
  const onBrowse = (path: string) =>
    path === "/old/"
      ? new Promise<{ directories: typeof entries; truncated: boolean }>((resolve) => {
          old = resolve;
        })
      : Promise.resolve({ directories: [], truncated: false });
  await render(
    <AddProjectDialog
      onAdd={() => Promise.resolve()}
      onBrowse={onBrowse}
      onClose={() => undefined}
    />,
  );
  await userEvent.fill(input(), "/old/");
  await vi.waitFor(() => expect(old).toBeDefined());
  await userEvent.fill(input(), "/new/");
  old({ directories: entries, truncated: false });
  await expect.element(page.getByText("No directories found.")).toBeVisible();
  await expect.element(page.getByRole("option")).not.toBeInTheDocument();
});

test("closing aborts browse and a committed add cannot close a later dialog", async () => {
  let signal: AbortSignal | undefined;
  let finish!: () => void;
  const close = vi.fn<() => void>();
  const screen = await render(
    <AddProjectDialog
      onAdd={() =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
      }
      onBrowse={(_path, currentSignal) => {
        signal = currentSignal;
        return browse();
      }}
      onClose={close}
    />,
  );
  await userEvent.keyboard("{Enter}");
  await screen.unmount();
  expect(signal?.aborted).toBe(true);
  finish();
  await Promise.resolve();
  expect(close).not.toHaveBeenCalled();
});
