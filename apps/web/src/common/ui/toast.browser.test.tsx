import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { toast, ToastProvider } from "./index.ts";

/** Raises one toast from a control, as a module would from its own handler. */
function Harness({
  title,
  type,
  timeout = 0,
}: {
  title: string;
  type?: string | undefined;
  timeout?: number | undefined;
}) {
  return (
    <ToastProvider>
      <button type="button" onClick={() => toast.add({ title, type, timeout })}>
        Raise
      </button>
    </ToastProvider>
  );
}

/** Two controls for one id: the second raise must replace the first, not stack on it. */
function Raiser() {
  return (
    <ToastProvider>
      <button type="button" onClick={() => toast.add({ id: "copy", title: "Path", timeout: 0 })}>
        First
      </button>
      <button type="button" onClick={() => toast.add({ id: "copy", title: "Branch", timeout: 0 })}>
        Second
      </button>
    </ToastProvider>
  );
}

/** Two different ids: two cards at once, which is the only state that shows their order. */
function Pair() {
  return (
    <ToastProvider>
      <button
        type="button"
        onClick={() => toast.add({ id: "a", title: "Older notice", timeout: 0 })}
      >
        Raise older
      </button>
      <button
        type="button"
        onClick={() => toast.add({ id: "b", title: "Newer notice", timeout: 0 })}
      >
        Raise newer
      </button>
    </ToastProvider>
  );
}

/** The card carrying `text`, read from the document the toast portal appends to. */
function toastCard(text: string): HTMLElement {
  const element = [...document.querySelectorAll<HTMLElement>('[data-slot="toast"]')].find(
    (candidate) => candidate.textContent?.includes(text) ?? false,
  );
  if (element === undefined) throw new Error(`the ${text} card is missing`);
  return element;
}

/** The card's own content wrapper, the part that hides while the card sits behind the front one. */
function toastContentOpacity(text: string): string {
  const content = toastCard(text).querySelector(".visual-toast-content");
  return content instanceof HTMLElement ? getComputedStyle(content).opacity : "missing";
}

test("a raised toast shows its glyph and title, and dismisses on request", async () => {
  const { unmount } = await render(<Harness title="Workspace path copied" type="success" />);
  await userEvent.click(page.getByRole("button", { name: "Raise" }));
  await expect.element(page.getByText("Workspace path copied")).toBeVisible();
  expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(1);
  expect(document.querySelector('[data-slot="toast-icon"]')?.getAttribute("data-tone")).toBe(
    "success",
  );

  await userEvent.click(page.getByRole("button", { name: "Dismiss notification" }));
  await expect.poll(() => document.querySelector('[data-slot="toast"]')).toBeNull();
  await unmount();
});

test("an untyped toast has no glyph, so a plain notice stays one line", async () => {
  const { unmount } = await render(<Harness title="Plain notice" />);
  await userEvent.click(page.getByRole("button", { name: "Raise" }));
  await expect.element(page.getByText("Plain notice")).toBeVisible();
  expect(document.querySelector('[data-slot="toast-icon"]')).toBeNull();
  await unmount();
});

test("one id keeps a single toast: a second raise replaces the first", async () => {
  const { unmount } = await render(<Raiser />);
  await userEvent.click(page.getByRole("button", { name: "First" }));
  await expect.element(page.getByText("Path")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Second" }));
  await expect.element(page.getByText("Branch")).toBeVisible();
  await expect.element(page.getByText("Path")).not.toBeInTheDocument();
  expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(1);
  await unmount();
});

test("two toasts stack at the corner, the newer one in front", async () => {
  const { unmount } = await render(<Pair />);
  await userEvent.click(page.getByRole("button", { name: "Raise older" }));
  await expect.element(page.getByText("Older notice")).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Raise newer" }));
  await expect.element(page.getByText("Newer notice")).toBeVisible();
  await expect.poll(() => document.querySelectorAll('[data-slot="toast"]').length).toBe(2);

  // Collapsed: the newer card rests at the corner, the older peeks out above it, scaled down and
  // with its content hidden.
  await expect
    .poll(() => toastCard("Newer notice").getBoundingClientRect().bottom)
    .toBeLessThanOrEqual(window.innerHeight - 12);
  const newer = toastCard("Newer notice").getBoundingClientRect();
  const older = toastCard("Older notice").getBoundingClientRect();
  expect(newer.bottom).toBeGreaterThan(older.bottom);
  expect(older.width).toBeLessThan(newer.width);
  expect(toastContentOpacity("Older notice")).toBe("0");
  // A card behind the front one keeps its own dismiss, hidden until the stack expands.
  expect(page.getByRole("button", { name: "Dismiss notification" }).elements()).toHaveLength(1);

  // Hovering expands the stack: both cards full width, the older one above with the gap between.
  await userEvent.hover(page.getByText("Newer notice"));
  await expect
    .poll(() => toastCard("Older notice").getBoundingClientRect().width)
    .toBeCloseTo(newer.width, 0);
  const expandedOlder = toastCard("Older notice").getBoundingClientRect();
  expect(expandedOlder.bottom).toBeLessThanOrEqual(newer.top);
  expect(toastContentOpacity("Older notice")).toBe("1");
  expect(page.getByRole("button", { name: "Dismiss notification" }).elements()).toHaveLength(2);
  await unmount();
});

test("type error reads as a failure in the region", async () => {
  const { unmount } = await render(
    <Harness title="Clipboard access is unavailable." type="error" />,
  );
  await userEvent.click(page.getByRole("button", { name: "Raise" }));
  await expect.element(page.getByText("Clipboard access is unavailable.")).toBeVisible();
  expect(document.querySelector('[data-slot="toast"]')?.getAttribute("data-tone")).toBe("error");
  expect(document.querySelector('[data-slot="toast-icon"]')?.getAttribute("data-tone")).toBe(
    "error",
  );
  await unmount();
});

test("a toast with a timeout leaves on its own", async () => {
  const { unmount } = await render(<Harness title="Gone shortly" timeout={100} />);
  await userEvent.click(page.getByRole("button", { name: "Raise" }));
  await expect.element(page.getByText("Gone shortly")).toBeVisible();
  await expect.poll(() => document.querySelector('[data-slot="toast"]')).toBeNull();
  await unmount();
});
