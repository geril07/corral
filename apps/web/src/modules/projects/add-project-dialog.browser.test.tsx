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

test("entering a folder drops the highlight instead of keeping the same row", async () => {
  const rootEntries = Array.from({ length: 10 }, (_, index) => ({
    name: `dir-${index}`,
    path: `/root/dir-${index}/`,
  }));
  const childEntries = Array.from({ length: 8 }, (_, index) => ({
    name: `child-${index}`,
    path: `/root/dir-5/child-${index}/`,
  }));
  const onBrowse = (path: string) =>
    Promise.resolve({
      directories: path === "/root/" ? rootEntries : childEntries,
      truncated: false,
    });
  await render(
    <AddProjectDialog
      onAdd={() => Promise.resolve()}
      onBrowse={onBrowse}
      onClose={() => undefined}
    />,
  );
  await userEvent.fill(input(), "/root/");
  await expect.element(page.getByRole("option", { name: "dir-0", exact: true })).toBeVisible();
  await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
  await expect
    .element(page.getByRole("button", { name: "Add project (Ctrl+Enter)", exact: true }))
    .toBeVisible();
  await userEvent.keyboard("{Enter}");
  await expect.element(input()).toHaveValue("/root/dir-5/");
  await expect.element(page.getByRole("option", { name: "child-0", exact: true })).toBeVisible();
  // The next folder starts from the top: no row is highlighted, so Enter adds the path.
  expect(document.querySelector("[data-highlighted]")).toBeNull();
  expect(input().element().getAttribute("aria-activedescendant")).toBeNull();
  await expect
    .element(page.getByRole("button", { name: "Add project (Enter)", exact: true }))
    .toBeVisible();
});

test("entering a long folder leaves the caret and the text at the end", async () => {
  const long = `/parent/${"a".repeat(60)}/`;
  await render(
    <AddProjectDialog
      onAdd={() => Promise.resolve()}
      onBrowse={() =>
        Promise.resolve({ directories: [{ name: "deep", path: long }], truncated: false })
      }
      onClose={() => undefined}
    />,
  );
  await userEvent.fill(input(), "/parent/");
  await expect.element(page.getByRole("option", { name: "deep", exact: true })).toBeVisible();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await expect.element(input()).toHaveValue(long);
  const element = input().element();
  if (!(element instanceof HTMLInputElement)) throw new Error("the path field is not an input");
  expect(element.selectionStart).toBe(long.length);
  expect(element.selectionEnd).toBe(long.length);
  expect(element.scrollLeft).toBeGreaterThan(0);
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
  // The action's own label carries the state; there is no second line under the list.
  await expect.element(page.getByText("Adding project…")).not.toBeInTheDocument();
  reject(new Error("no such directory"));
  await expect.element(page.getByText("no such directory", { exact: true })).toBeVisible();
  await expect.element(input()).toHaveValue("/missing");
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1));
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
  await expect.element(page.getByText("No directories found", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("option")).not.toBeInTheDocument();
});

test("the settled list stays while the next path is still loading", async () => {
  let next!: (result: { directories: typeof entries; truncated: boolean }) => void;
  const onBrowse = (path: string) =>
    path === "/parent/"
      ? browse()
      : path === "/parent/a"
        ? new Promise<{ directories: typeof entries; truncated: boolean }>((resolve) => {
            next = resolve;
          })
        : Promise.resolve({ directories: [], truncated: false });
  await render(
    <AddProjectDialog
      onAdd={() => Promise.resolve()}
      onBrowse={onBrowse}
      onClose={() => undefined}
    />,
  );
  await userEvent.fill(input(), "/parent/");
  await expect.element(page.getByRole("option", { name: "alpha", exact: true })).toBeVisible();
  await userEvent.fill(input(), "/parent/a");
  await vi.waitFor(() => expect(next).toBeDefined());
  // Rows from the previous path stay put; nothing announces a load and nothing collapses.
  await expect.element(page.getByRole("option", { name: "alpha", exact: true })).toBeVisible();
  await expect.element(page.getByText("Loading directories…")).not.toBeInTheDocument();
  next({ directories: [], truncated: false });
  await expect.element(page.getByText("No directories found", { exact: true })).toBeVisible();
});

test("an empty result does not blink off while the next path is loading", async () => {
  let next!: (result: { directories: typeof entries; truncated: boolean }) => void;
  const onBrowse = (path: string) =>
    path === "/missing/"
      ? Promise.resolve({ directories: [], truncated: false })
      : path === "/missing/deeper/"
        ? new Promise<{ directories: typeof entries; truncated: boolean }>((resolve) => {
            next = resolve;
          })
        : Promise.resolve({ directories: [], truncated: false });
  await render(
    <AddProjectDialog
      onAdd={() => Promise.resolve()}
      onBrowse={onBrowse}
      onClose={() => undefined}
    />,
  );
  await userEvent.fill(input(), "/missing/");
  const message = page.getByText("No directories found", { exact: true });
  await expect.element(message).toBeVisible();
  // The answer for the longer path is still in flight; the previous empty answer stays on screen
  // instead of clearing and coming back.
  await userEvent.fill(input(), "/missing/deeper/");
  await vi.waitFor(() => expect(next).toBeDefined());
  await expect.element(message).toBeVisible();
  next({ directories: [], truncated: false });
  await expect.element(message).toBeVisible();
});

test("a listing error stays put while the next path is loading", async () => {
  let next!: (result: { directories: typeof entries; truncated: boolean }) => void;
  const onBrowse = (path: string) =>
    path === "/bad/"
      ? Promise.reject(new Error("Use an absolute server path or ~/."))
      : path === "/bad/deeper/"
        ? new Promise<{ directories: typeof entries; truncated: boolean }>((resolve) => {
            next = resolve;
          })
        : Promise.resolve({ directories: [], truncated: false });
  await render(
    <AddProjectDialog
      onAdd={() => Promise.resolve()}
      onBrowse={onBrowse}
      onClose={() => undefined}
    />,
  );
  await userEvent.fill(input(), "/bad/");
  const error = page.getByText("Use an absolute server path or ~/.", { exact: true });
  await expect.element(error).toBeVisible();
  await userEvent.fill(input(), "/bad/deeper/");
  await vi.waitFor(() => expect(next).toBeDefined());
  // The error is the last settled answer: it does not flip to "no directories" mid-request.
  await expect.element(error).toBeVisible();
  await expect
    .element(page.getByText("No directories found", { exact: true }))
    .not.toBeInTheDocument();
  next({ directories: [], truncated: false });
  await expect.element(page.getByText("No directories found", { exact: true })).toBeVisible();
  await expect.element(error).not.toBeInTheDocument();
});

const many = Array.from({ length: 40 }, (_, index) => ({
  name: `folder-${index}`,
  path: `/many/folder-${index}/`,
}));

function browseByPath(path: string) {
  return Promise.resolve({
    directories: path === "/many/" ? many : entries,
    truncated: false,
  });
}

test("the dialog hangs from a fixed top edge while results change", async () => {
  await render(
    <AddProjectDialog
      onAdd={() => Promise.resolve()}
      onBrowse={browseByPath}
      onClose={() => undefined}
    />,
  );
  const dialog = page.getByRole("dialog", { name: "Add project" });
  const top = () => dialog.element().getBoundingClientRect().top;
  await userEvent.fill(input(), "/parent/");
  await expect.element(page.getByRole("option", { name: "alpha", exact: true })).toBeVisible();
  // 1024×640: max(48, (640 - 480) / 2) = 80, the OpenCode anchor. Precision 1 waits out the
  // opening scale so the measured edge is the settled one.
  await vi.waitFor(() => expect(top()).toBeCloseTo(80, 1));
  const shortTop = top();
  await userEvent.fill(input(), "/many/");
  await vi.waitFor(() =>
    expect(page.getByRole("listbox", { name: "Directories" }).element().clientHeight).toBe(288),
  );
  expect(top()).toBe(shortTop);
});

test("the list scrolls rows only, with its gap outside the scroller", async () => {
  await render(
    <AddProjectDialog
      onAdd={() => Promise.resolve()}
      onBrowse={() => Promise.resolve({ directories: many, truncated: false })}
      onClose={() => undefined}
    />,
  );
  await userEvent.fill(input(), "/many/");
  const list = page.getByRole("listbox", { name: "Directories" });
  await expect.element(list).toBeVisible();
  const element = list.element();
  if (!(element instanceof HTMLElement)) throw new Error("the directory list is not an element");
  // The frame owns the vertical gap: no padding inside the scroller to scroll through.
  expect(getComputedStyle(element).paddingTop).toBe("0px");
  element.scrollTop = element.scrollHeight;
  await vi.waitFor(() =>
    expect(element.scrollTop).toBe(element.scrollHeight - element.clientHeight),
  );
  const last = page.getByRole("option", { name: "folder-39", exact: true }).element();
  const gap = element.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom;
  expect(gap).toBeGreaterThanOrEqual(-0.5);
  expect(gap).toBeLessThanOrEqual(1);
});

test("empty and settled-empty states share one option row", async () => {
  await render(
    <AddProjectDialog
      onAdd={() => Promise.resolve()}
      onBrowse={(path) =>
        Promise.resolve({
          directories: path === "/parent/" ? entries : [],
          truncated: false,
        })
      }
      onClose={() => undefined}
    />,
  );
  await userEvent.fill(input(), "/parent/");
  const option = page.getByRole("option", { name: "alpha", exact: true });
  await expect.element(option).toBeVisible();
  const optionElement = option.element();
  const rowHeight = optionElement instanceof HTMLElement ? optionElement.offsetHeight : 0;
  await userEvent.fill(input(), "/empty/");
  const message = page.getByText("No directories found", { exact: true });
  await expect.element(message).toBeVisible();
  const messageRow = document.querySelector<HTMLElement>('[data-slot="path-picker-message"]');
  expect(messageRow?.offsetHeight).toBe(rowHeight);
});

test("an emptied path lists nothing and never claims it found no directories", async () => {
  await render(
    <AddProjectDialog
      onAdd={() => Promise.resolve()}
      onBrowse={() => Promise.resolve({ directories: entries, truncated: false })}
      onClose={() => undefined}
    />,
  );
  await userEvent.fill(input(), "/parent/");
  await expect.element(page.getByRole("option", { name: "alpha", exact: true })).toBeVisible();
  await userEvent.fill(input(), "");
  await expect.element(page.getByRole("option")).not.toBeInTheDocument();
  await expect
    .element(page.getByText("No directories found", { exact: true }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: /Add project/ })).toBeDisabled();
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
  await vi.waitFor(() => expect(signal).toBeDefined());
  await expect.element(input()).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(finish).toBeDefined());
  await screen.unmount();
  expect(signal?.aborted).toBe(true);
  finish();
  await Promise.resolve();
  expect(close).not.toHaveBeenCalled();
});
