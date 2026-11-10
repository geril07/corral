import type { Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { useState } from "react";
import { render } from "vitest-browser-react";
import type { VisualTaskRow } from "../../common/ui/index.ts";
import { stubClipboard } from "../../../test/clipboard.ts";
import { prefixThen } from "../../../test/real-client.ts";
import { RemoveTaskDialog } from "../tasks/index.ts";
import { VISUAL_REVIEW_ROWS, VISUAL_REVIEW_SELECTED } from "./visual-fixtures.ts";
import { VisualShellView, type VisualTaskActions } from "./visual-view.tsx";

const SHORTCUT = { prefix: "alt+a", binding: "\\" };
const RENAME_SHORTCUT = { prefix: "alt+a", binding: "e" };
const SETTLE_SHORTCUT = { prefix: "alt+a", binding: "d" };
const FIRST = VISUAL_REVIEW_ROWS[0]!;

function Harness() {
  const [selected, setSelected] = useState<string | null>(VISUAL_REVIEW_SELECTED);
  return (
    <VisualShellView
      rows={VISUAL_REVIEW_ROWS}
      selectedId={selected}
      projectsLoaded
      tasksLoaded
      failure={undefined}
      shortcut={SHORTCUT}
      onSelectTask={setSelected}
    />
  );
}

function cardButton(index: number) {
  return page.getByRole("button", { name: new RegExp(VISUAL_REVIEW_ROWS[index]!.title) });
}

function menuActions() {
  return {
    onRename: vi.fn<(id: string) => void>(),
    onToggleSettle: vi.fn<(id: string) => void>(),
    onRemove: vi.fn<(id: string) => void>(),
    onViewSource: vi.fn<(id: string) => void>(),
  };
}

function MenuHarness({
  actions,
  rows = VISUAL_REVIEW_ROWS,
}: {
  actions: VisualTaskActions;
  rows?: readonly VisualTaskRow[];
}) {
  const [selected, setSelected] = useState<string | null>(rows[0]?.id ?? null);
  return (
    <VisualShellView
      rows={rows}
      selectedId={selected}
      projectsLoaded
      tasksLoaded
      failure={undefined}
      shortcut={SHORTCUT}
      renameShortcut={RENAME_SHORTCUT}
      settleShortcut={SETTLE_SHORTCUT}
      taskActions={actions}
      onSelectTask={setSelected}
    />
  );
}

async function openRowMenu(title: string) {
  const card = page.getByRole("button", { name: new RegExp(title) });
  await userEvent.click(card, { button: "right" });
  await expect.element(page.getByRole("menu")).toBeVisible();
}

function menuNames(): (string | undefined)[] {
  return page
    .getByRole("menuitem")
    .elements()
    .map((element) => {
      // Shortcut cells are visual and aria-hidden; the label is what the item is.
      const clone = element.cloneNode(true);
      if (!(clone instanceof HTMLElement)) return undefined;
      for (const shortcut of clone.querySelectorAll('[data-slot="dropdown-menu-shortcut"]')) {
        shortcut.remove();
      }
      return clone.textContent?.replace(/\s+/g, " ").trim();
    });
}

function shortcutCells(): (string | undefined)[] {
  return [...document.querySelectorAll('[data-slot="dropdown-menu-shortcut"]')].map((element) =>
    element.textContent?.trim(),
  );
}

const copyNotice = () => document.querySelector(".visual-copy-notice")?.textContent;

function taskOf(row: VisualTaskRow): Task {
  return {
    id: row.id,
    projectId: "p1",
    title: row.title,
    titleSource: "user",
    prompt: null,
    primarySessionId: null,
    branch: row.metadata.branch ?? null,
    workspacePath: row.workspacePath,
    ownsWorktree: true,
    state: row.state,
    seenAt: null,
    createdAt: 0,
  };
}

function tooltipText(): string | null {
  return document.querySelector('[role="tooltip"]')?.textContent ?? null;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

test("a card selects the task, and ArrowDown moves selection and focus", async () => {
  const { container, unmount } = await render(<Harness />);
  await expect
    .element(page.getByRole("heading", { name: VISUAL_REVIEW_ROWS[0]!.title }))
    .toBeVisible();

  await userEvent.click(cardButton(2));
  await expect
    .element(page.getByRole("heading", { name: VISUAL_REVIEW_ROWS[2]!.title }))
    .toBeVisible();
  expect(
    container.querySelector('[data-task-id="fixture-done-unseen"]')?.getAttribute("aria-current"),
  ).toBe("true");

  await userEvent.keyboard("{ArrowDown}");
  await expect
    .element(page.getByRole("heading", { name: VISUAL_REVIEW_ROWS[3]!.title }))
    .toBeVisible();
  await expect
    .poll(() => document.activeElement?.getAttribute("data-task-id"))
    .toBe("fixture-working");
  await unmount();
});

test("hover/focus swaps the status slot for the unavailable Settle action without moving the title", async () => {
  const { container, unmount } = await render(<Harness />);
  const first = container.querySelector(".visual-task-card");
  if (!(first instanceof HTMLElement)) throw new Error("first card is missing");
  const action = first.querySelector<HTMLElement>(".visual-task-slot-action");
  if (action === null) throw new Error("action slot is missing");
  expect(getComputedStyle(action).opacity).toBe("0");

  await userEvent.click(cardButton(0));
  await expect.poll(() => getComputedStyle(action).opacity).toBe("1");
  const settle = first.querySelector<HTMLButtonElement>(".visual-task-action");
  expect(settle?.getAttribute("aria-disabled")).toBe("true");
  expect(settle?.hasAttribute("disabled")).toBe(false);
  await unmount();
});

test("the metadata tooltip opens on hover after the 300 ms cold delay without taking focus", async () => {
  const { container, unmount } = await render(<Harness />);
  const hit = container.querySelector<HTMLElement>('[data-task-id="fixture-blocked"]');
  if (hit === null) throw new Error("card is missing");

  await userEvent.hover(hit);
  // A cold trigger cannot already be open at pointer entry.
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await expect.element(page.getByRole("tooltip")).toBeVisible();
  expect(document.activeElement).not.toBe(hit);

  const text = document.querySelector('[role="tooltip"]')?.textContent ?? "";
  expect(text).toContain(FIRST.title);
  expect(text).toContain("fix/oauth-token-refresh");
  expect(text).toContain("pi · anthropic/claude-sonnet-4-5");
  expect(text).not.toContain("Workspace");
  expect(text).not.toContain("/home/");
  expect(text.match(/orbit/g) ?? []).toHaveLength(1);

  window.dispatchEvent(new Event("scroll"));
  await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
  await unmount();
});

test("only task-list hops warm; standalone and disabled controls stay cold", async () => {
  const { container, unmount } = await render(<Harness />);
  const hits = VISUAL_REVIEW_ROWS.map((row) =>
    container.querySelector<HTMLElement>(`[data-task-id="${row.id}"]`),
  );
  const first = hits[0];
  const second = hits[1];
  const third = hits[2];
  if (first == null || second == null || third == null) throw new Error("cards are missing");

  await userEvent.hover(first);
  await expect.poll(tooltipText).toContain(FIRST.title);

  // A neighbouring task opens during the provider's short warm window.
  await userEvent.unhover(first);
  await userEvent.hover(second);
  await nextFrame();
  expect(tooltipText()).toContain(VISUAL_REVIEW_ROWS[1]!.title);

  // Moving into the header is outside that provider, so it waits again.
  const hide = page.getByRole("button", { name: "Hide sidebar" });
  await userEvent.hover(hide);
  await nextFrame();
  expect(tooltipText() ?? "").not.toContain("Hide sidebar");
  await expect.poll(tooltipText).toContain("Hide sidebar");

  // Coming back from the header is cold for the task list too.
  await userEvent.hover(third);
  await nextFrame();
  expect(tooltipText() ?? "").not.toContain(VISUAL_REVIEW_ROWS[2]!.title);
  await expect.poll(tooltipText).toContain(VISUAL_REVIEW_ROWS[2]!.title);

  // A disabled explanation uses the same cold delay, not a special zero.
  const search = page.getByRole("button", { name: /Search tasks/ });
  await userEvent.hover(search);
  await nextFrame();
  expect(tooltipText() ?? "").not.toContain("Task search is not part of this visual slice.");
  await expect.poll(tooltipText).toContain("Task search is not part of this visual slice.");
  await unmount();
});

test("the card status strip is not a pointer dead zone, and Settle replaces rather than conflicts", async () => {
  const { container, unmount } = await render(<Harness />);
  const hits = [...container.querySelectorAll<HTMLElement>(".visual-task-card-hit")];
  if (hits.length === 0) throw new Error("cards are missing");

  for (const hit of hits) {
    const box = hit.getBoundingClientRect();
    const target = document.elementFromPoint(box.right - 45, box.top + 12);
    expect(target?.closest(".visual-task-slot")).toBeNull();
    expect(target?.closest(".visual-task-card-hit")).toBe(hit);
  }

  const hit = hits[0]!;
  await userEvent.hover(hit);
  await expect.poll(tooltipText).toContain(FIRST.title);

  const settle = hit
    .closest(".visual-task-card")
    ?.querySelector<HTMLElement>(".visual-task-action");
  if (settle === null || settle === undefined) throw new Error("Settle action is missing");
  await userEvent.hover(settle);
  await expect.poll(tooltipText).toContain("Settle task");
  expect(document.querySelector(".visual-metadata-tooltip")).toBeNull();
  expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);

  await userEvent.hover(hit);
  await expect.poll(tooltipText).toContain(FIRST.title);
  expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1);
  await unmount();
});

test("a warm task hop replaces metadata instantly without replaying fades", async () => {
  const { container, unmount } = await render(<Harness />);
  const first = container.querySelector<HTMLElement>('[data-task-id="fixture-blocked"]');
  const second = container.querySelector<HTMLElement>('[data-task-id="fixture-error"]');
  if (first == null || second == null) throw new Error("cards are missing");

  await userEvent.hover(first);
  await expect.poll(tooltipText).toContain(FIRST.title);
  const cold = document.querySelector<HTMLElement>(".visual-metadata-tooltip");
  expect(cold?.hasAttribute("data-instant")).toBe(false);

  await userEvent.unhover(first);
  await userEvent.hover(second);
  await nextFrame();
  const warm = document.querySelector<HTMLElement>(".visual-metadata-tooltip");
  expect(warm?.textContent).toContain(VISUAL_REVIEW_ROWS[1]!.title);
  expect(warm?.hasAttribute("data-instant")).toBe(true);
  expect(warm?.getAnimations()).toHaveLength(0);
  expect(document.querySelectorAll(".visual-metadata-tooltip")).toHaveLength(1);
  await unmount();
});

test("keyboard focus opens metadata, Escape closes it, and a host with no actions leaves right-click alone", async () => {
  const { container, unmount } = await render(<Harness />);
  await userEvent.click(cardButton(2));
  await userEvent.keyboard("{ArrowDown}");

  const focused = container.querySelector<HTMLElement>('[data-task-id="fixture-working"]');
  if (focused === null) throw new Error("focused card is missing");
  await expect.poll(() => document.activeElement).toBe(focused);
  // Focus opens immediately through the library; this must not be mistaken for the hover delay.
  await nextFrame();
  expect(tooltipText()).toContain("refactor/session-reconnect-handshake");
  await expect.element(page.getByRole("tooltip")).toBeVisible();
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
    "refactor/session-reconnect-handshake",
  );
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
    "codex · openai/gpt-5-codex",
  );

  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
  expect(document.activeElement).toBe(focused);

  const context = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  focused.dispatchEvent(context);
  expect(context.defaultPrevented).toBe(false);
  expect(page.getByRole("menu").elements()).toHaveLength(0);
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await unmount();
});

test("an unavailable action stacks its title over the wrapped reason instead of using columns", async () => {
  const { container, unmount } = await render(<Harness />);
  await userEvent.click(cardButton(0));
  const first = container.querySelector(".visual-task-card");
  if (!(first instanceof HTMLElement)) throw new Error("first card is missing");
  const settle = first.querySelector<HTMLElement>(".visual-task-action");
  if (settle === null) throw new Error("settle action is missing");

  await userEvent.hover(settle);
  await expect.element(page.getByRole("tooltip")).toBeVisible();
  const popup = document.querySelector<HTMLElement>(".visual-tooltip-explanation");
  const heading = popup?.querySelector<HTMLElement>(".visual-tooltip-heading");
  const reason = popup?.querySelector<HTMLElement>(".visual-tooltip-reason");
  if (popup === null || heading === undefined || reason === undefined) {
    throw new Error("explanation tooltip is incomplete");
  }
  if (heading === null || reason === null) throw new Error("explanation rows are missing");

  const headingBox = heading.getBoundingClientRect();
  const reasonBox = reason.getBoundingClientRect();
  expect(getComputedStyle(popup).flexDirection).toBe("column");
  expect(popup.getBoundingClientRect().width).toBeLessThanOrEqual(280);
  expect(reasonBox.top).toBeGreaterThanOrEqual(headingBox.bottom);
  expect(Math.abs(reasonBox.left - headingBox.left)).toBeLessThan(1);
  expect(reasonBox.height).toBeGreaterThan(15);

  const before = getComputedStyle(settle).backgroundColor;
  await userEvent.unhover(settle);
  await expect.poll(() => getComputedStyle(settle).backgroundColor).not.toBe(before);
  expect(getComputedStyle(settle).cursor).toBe("not-allowed");
  await unmount();
});

test("the resize grip straddles the boundary, shows a pill only on dwell or drag, and keeps keyboard resize", async () => {
  const { container, unmount } = await render(<Harness />);
  const aside = container.querySelector<HTMLElement>(".visual-shell-sidebar");
  if (aside === null) throw new Error("sidebar frame is missing");
  const handle = page.getByRole("separator", { name: "Resize sidebar" }).element();
  const pill = () => getComputedStyle(handle, "::after");

  const boundary = () => {
    const box = handle.getBoundingClientRect();
    return Math.abs(box.left + box.width / 2 - aside.getBoundingClientRect().right);
  };
  expect(handle.getBoundingClientRect().width).toBe(8);
  expect(boundary()).toBeLessThan(1);
  expect(pill().width).toBe("4px");
  expect(pill().height).toBe("40px");
  expect(pill().opacity).toBe("0");

  await userEvent.hover(handle);
  expect(pill().opacity).toBe("0");
  await expect.poll(() => pill().opacity).toBe("1");

  Object.defineProperties(handle, {
    setPointerCapture: { configurable: true, value: () => undefined },
    releasePointerCapture: { configurable: true, value: () => undefined },
    hasPointerCapture: { configurable: true, value: () => true },
  });
  const before = Number(handle.getAttribute("aria-valuenow"));
  const startX = handle.getBoundingClientRect().left + 4;
  handle.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      clientX: startX,
    }),
  );
  await expect.poll(() => handle.getAttribute("data-dragging")).toBe("true");
  handle.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      clientX: startX + 32,
    }),
  );
  handle.dispatchEvent(
    new PointerEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      clientX: startX + 32,
    }),
  );
  await expect.poll(() => Number(handle.getAttribute("aria-valuenow"))).toBe(before + 32);
  await expect.poll(() => handle.hasAttribute("data-dragging")).toBe(false);
  expect(localStorage.getItem("corral.visual-sidebar-width")).toBe(String(before + 32));
  expect(boundary()).toBeLessThan(1);

  await userEvent.unhover(handle);
  await expect.poll(() => pill().opacity).toBe("0");
  await userEvent.keyboard("{Tab}");
  handle.focus();
  expect(handle.matches(":focus-visible")).toBe(true);
  expect(pill().opacity).toBe("1");
  expect(pill().boxShadow).toContain("118, 152, 253");
  expect(getComputedStyle(handle).outlineStyle).toBe("none");

  handle.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowRight" }),
  );
  await expect.poll(() => Number(handle.getAttribute("aria-valuenow"))).toBe(before + 32 + 16);
  // The preference is device-local; leave the following tests on their expected default.
  localStorage.setItem("corral.visual-sidebar-width", "320");
  await unmount();
});

test("the sidebar can be dragged to 100, keeps essential controls reachable, and still hands off one toggle", async () => {
  const { container, unmount } = await render(<Harness />);
  const aside = container.querySelector<HTMLElement>(".visual-shell-sidebar");
  if (aside === null) throw new Error("sidebar frame is missing");
  const handle = page.getByRole("separator", { name: "Resize sidebar" }).element();
  Object.defineProperties(handle, {
    setPointerCapture: { configurable: true, value: () => undefined },
    releasePointerCapture: { configurable: true, value: () => undefined },
    hasPointerCapture: { configurable: true, value: () => true },
  });
  const startX = handle.getBoundingClientRect().left + 4;
  handle.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      clientX: startX,
    }),
  );
  handle.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      clientX: startX - 500,
    }),
  );
  handle.dispatchEvent(
    new PointerEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      clientX: startX - 500,
    }),
  );

  await expect.poll(() => Number(handle.getAttribute("aria-valuenow"))).toBe(100);
  await expect.poll(() => Math.round(aside.getBoundingClientRect().width)).toBe(100);
  expect(localStorage.getItem("corral.visual-sidebar-width")).toBe("100");

  const toggles = () => [
    ...container.querySelectorAll<HTMLButtonElement>('button[aria-controls="visual-sidebar"]'),
  ];
  expect(toggles()).toHaveLength(1);
  const openSlot = container.querySelector<HTMLElement>(
    ".visual-sidebar-header .visual-toggle-slot",
  );
  if (openSlot === null) throw new Error("open toggle slot is missing");
  const toggle = toggles()[0]!;
  const openBox = openSlot.getBoundingClientRect();
  const toggleBox = toggle.getBoundingClientRect();
  expect(Math.abs(toggleBox.left - openBox.left)).toBeLessThan(1);

  const controls = [
    toggle,
    container.querySelector<HTMLElement>(".visual-search-row"),
    container.querySelector<HTMLElement>('[aria-label="New task"]'),
    container.querySelector<HTMLElement>('[aria-label="Settings"]'),
    container.querySelector<HTMLElement>('[aria-label="Add project"]'),
  ];
  for (const control of controls) {
    if (control === null) throw new Error("essential control is missing");
    const box = control.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(0);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(window.innerWidth);
    const atCenter = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    expect(control.contains(atCenter)).toBe(true);
  }

  await userEvent.click(toggle);
  await expect.poll(() => Math.round(aside.getBoundingClientRect().width)).toBe(0);
  expect(toggles()).toHaveLength(1);
  await userEvent.click(toggles()[0]!);
  await expect.poll(() => Math.round(aside.getBoundingClientRect().width)).toBe(100);
  expect(
    Math.abs(toggles()[0]!.getBoundingClientRect().left - openSlot.getBoundingClientRect().left),
  ).toBeLessThan(1);
  expect(document.activeElement).toBe(toggles()[0]);

  // Leave the following tests on their expected default.
  localStorage.setItem("corral.visual-sidebar-width", "320");
  await unmount();
});

test("one toggle travels with the sidebar edge and keeps focus across hide and show", async () => {
  const { container, unmount } = await render(<Harness />);
  const aside = container.querySelector<HTMLElement>(".visual-shell-sidebar");
  const surface = container.querySelector<HTMLElement>(".visual-sidebar-surface");
  const chrome = container.querySelector<HTMLElement>(".visual-main-chrome");
  const openSlot = container.querySelector<HTMLElement>(
    ".visual-sidebar-header .visual-toggle-slot",
  );
  const closedSlot = container.querySelector<HTMLElement>(
    ".visual-main-chrome .visual-toggle-slot",
  );
  const toggles = () => [
    ...container.querySelectorAll<HTMLButtonElement>('button[aria-controls="visual-sidebar"]'),
  ];
  if (
    aside === null ||
    surface === null ||
    chrome === null ||
    openSlot === null ||
    closedSlot === null
  ) {
    throw new Error("sidebar frame is missing");
  }
  expect(toggles()).toHaveLength(1);

  await userEvent.click(page.getByRole("button", { name: "Hide sidebar" }));
  await expect.poll(() => document.activeElement?.getAttribute("aria-label")).toBe("Show sidebar");
  await expect.poll(() => Math.round(aside.getBoundingClientRect().width)).toBe(0);
  // The contents keep the open width; the frame clips them instead of reflowing every frame.
  expect(Math.round(surface.getBoundingClientRect().width)).toBe(320);
  expect(chrome.getBoundingClientRect().height).toBe(40);
  expect(toggles()).toHaveLength(1);
  expect(toggles()[0]?.getAttribute("aria-expanded")).toBe("false");

  const toggle = toggles()[0]!;
  const closedBox = closedSlot.getBoundingClientRect();
  const hideBox = toggle.getBoundingClientRect();
  expect(Math.abs(hideBox.left - closedBox.left)).toBeLessThan(1);
  expect(Math.abs(hideBox.top - closedBox.top)).toBeLessThan(1);
  const eyebrow = container.querySelector<HTMLElement>(".visual-main-eyebrow");
  if (eyebrow === null) throw new Error("main eyebrow is missing");
  expect(hideBox.bottom).toBeLessThanOrEqual(eyebrow.getBoundingClientRect().top);

  await userEvent.click(toggle);
  await expect.poll(() => document.activeElement?.getAttribute("aria-label")).toBe("Hide sidebar");
  await expect.poll(() => Math.round(aside.getBoundingClientRect().width)).toBe(320);
  expect(Math.round(surface.getBoundingClientRect().width)).toBe(320);
  expect(toggles()).toHaveLength(1);
  expect(toggles()[0]?.getAttribute("aria-expanded")).toBe("true");
  const openBox = openSlot.getBoundingClientRect();
  const shownBox = toggles()[0]!.getBoundingClientRect();
  expect(Math.abs(shownBox.left - openBox.left)).toBeLessThan(1);
  expect(Math.abs(shownBox.top - openBox.top)).toBeLessThan(1);
  await unmount();
});

test("a rapid hide/show reversal stays continuous and settles open with one toggle", async () => {
  const { container, unmount } = await render(<Harness />);
  const aside = container.querySelector<HTMLElement>(".visual-shell-sidebar");
  if (aside === null) throw new Error("sidebar frame is missing");

  await userEvent.click(page.getByRole("button", { name: "Hide sidebar" }));
  const toggle = page.getByRole("button", { name: "Show sidebar" });
  await expect.element(toggle).toBeVisible();
  await userEvent.click(toggle);
  await expect.poll(() => Math.round(aside.getBoundingClientRect().width)).toBe(320);
  await expect.poll(() => document.activeElement?.getAttribute("aria-label")).toBe("Hide sidebar");
  expect(container.querySelectorAll('button[aria-controls="visual-sidebar"]')).toHaveLength(1);
  expect(window.localStorage.getItem("corral.visual-sidebar-width")).not.toBe("0");
  await unmount();
});

test("the toggle hides the sidebar, stays available in the main surface, and its tooltip uses the live keymap", async () => {
  const { container, unmount } = await render(<Harness />);
  const aside = container.querySelector<HTMLElement>(".visual-shell-sidebar");
  if (aside === null) throw new Error("sidebar frame is missing");
  const hide = page.getByRole("button", { name: "Hide sidebar" });
  await expect.element(hide).toBeVisible();
  await userEvent.click(hide);

  await expect.element(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();
  await expect.poll(() => Math.round(aside.getBoundingClientRect().width)).toBe(0);
  expect(aside.getAttribute("aria-hidden")).toBe("true");
  expect(container.querySelector(".visual-sidebar-surface")?.hasAttribute("inert")).toBe(true);

  await prefixThen("\\");
  await expect.poll(() => Math.round(aside.getBoundingClientRect().width)).toBe(320);
  await unmount();
});

test("unavailable actions say why in the compact tooltip and never claim to run", async () => {
  const { unmount } = await render(<Harness />);
  const search = page.getByRole("button", { name: /Search tasks/ });
  await expect.element(search).toHaveAttribute("aria-disabled", "true");
  await userEvent.hover(search);
  const tooltip = page.getByRole("tooltip");
  await expect.element(tooltip).toBeVisible();
  await expect.element(tooltip).toMatchTextContent("Task search is not part of this visual slice.");

  const hide = page.getByRole("button", { name: "Hide sidebar" });
  await userEvent.hover(hide);
  await expect.element(tooltip).toMatchTextContent("alt+a");
  await expect.element(tooltip).toMatchTextContent("\\");
  await unmount();
});

test("the row menu is copy, rename, settle, source, remove, with live shortcut cells and nothing invented", async () => {
  const actions = menuActions();
  const { unmount } = await render(<MenuHarness actions={actions} rows={[FIRST]} />);

  await openRowMenu(FIRST.title);
  expect(menuNames()).toEqual([
    "Copy",
    "Rename task…",
    "Settle task",
    "View issue source…",
    "Remove task…",
  ]);
  expect(shortcutCells()).toEqual(["alt+a e", "alt+a d"]);
  // The menu refuses the reference features whose contracts do not exist.
  for (const absent of [
    "Pin task",
    "Snooze",
    "Mark unread",
    "Regenerate title",
    "Turn into project",
  ]) {
    expect(page.getByRole("menuitem", { name: absent }).elements()).toHaveLength(0);
  }
  await unmount();
});

test("View issue source… exists only for a task that has a source", async () => {
  const actions = menuActions();
  const withoutSource: VisualTaskRow = { ...FIRST, hasSource: false };
  const { unmount } = await render(<MenuHarness actions={actions} rows={[withoutSource]} />);

  await openRowMenu(FIRST.title);
  await expect
    .element(page.getByRole("menuitem", { name: "View issue source…" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("menuitem", { name: "Remove task…" })).toBeVisible();
  await unmount();
});

test("copy writes the task path, branch and id, and each is confirmed in the copy notice", async () => {
  const clipboard = stubClipboard(async () => undefined);
  try {
    const actions = menuActions();
    const { unmount } = await render(<MenuHarness actions={actions} rows={[FIRST]} />);

    await openRowMenu(FIRST.title);
    await page.getByRole("menuitem", { name: "Copy" }).click();
    await page.getByRole("menuitem", { name: "Copy workspace path" }).click();
    await vi.waitFor(() =>
      expect(clipboard.writeText).toHaveBeenLastCalledWith(FIRST.workspacePath),
    );
    expect(copyNotice()).toBe("Workspace path copied");

    await openRowMenu(FIRST.title);
    await page.getByRole("menuitem", { name: "Copy" }).click();
    await page.getByRole("menuitem", { name: "Copy branch" }).click();
    await vi.waitFor(() =>
      expect(clipboard.writeText).toHaveBeenLastCalledWith(FIRST.metadata.branch),
    );
    expect(copyNotice()).toBe("Branch copied");

    await openRowMenu(FIRST.title);
    await page.getByRole("menuitem", { name: "Copy" }).click();
    await page.getByRole("menuitem", { name: "Copy task ID" }).click();
    await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenLastCalledWith(FIRST.id));
    expect(copyNotice()).toBe("Task ID copied");
    await unmount();
  } finally {
    clipboard.restore();
  }
});

test("a task without a branch has no Copy branch item, and every other copy item stays", async () => {
  const actions = menuActions();
  const branchless: VisualTaskRow = {
    ...FIRST,
    metadata: { ...FIRST.metadata, branch: undefined },
  };
  const screen = await render(<MenuHarness actions={actions} rows={[branchless]} />);

  await openRowMenu(FIRST.title);
  await page.getByRole("menuitem", { name: "Copy" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Copy workspace path" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Copy task ID" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Copy branch" })).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}{Escape}");

  // A detached create records "HEAD"; that is not a branch name to copy either.
  const detached: VisualTaskRow = { ...FIRST, metadata: { ...FIRST.metadata, branch: "HEAD" } };
  await screen.rerender(<MenuHarness actions={actions} rows={[detached]} />);
  await openRowMenu(FIRST.title);
  await page.getByRole("menuitem", { name: "Copy" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Copy branch" })).not.toBeInTheDocument();
  await screen.unmount();
});

test("a settled task's menu says Unsettle task and settles through the same action", async () => {
  const actions = menuActions();
  const settled: VisualTaskRow = { ...FIRST, state: "settled" };
  const { unmount } = await render(<MenuHarness actions={actions} rows={[settled]} />);

  await openRowMenu(FIRST.title);
  await expect.element(page.getByRole("menuitem", { name: "Unsettle task" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Settle task" })).not.toBeInTheDocument();
  await page.getByRole("menuitem", { name: "Unsettle task" }).click();
  await vi.waitFor(() => expect(actions.onToggleSettle).toHaveBeenCalledExactlyOnceWith(FIRST.id));
  await unmount();
});

test("Shift+F10 and the menu key open the row menu, arrows walk it, and Escape returns focus", async () => {
  const actions = menuActions();
  const { container, unmount } = await render(<MenuHarness actions={actions} rows={[FIRST]} />);
  const hit = container.querySelector<HTMLElement>(`[data-task-id="${FIRST.id}"]`);
  if (hit === null) throw new Error("the task card is missing");

  hit.focus();
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  await expect.element(page.getByRole("menu")).toBeVisible();
  // One popup at a time: the row's metadata tooltip yields to its menu.
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
  await userEvent.keyboard("{ArrowDown}");
  expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  expect(document.activeElement).toBe(hit);

  await userEvent.keyboard("{ContextMenu}");
  await expect.element(page.getByRole("menu")).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  expect(document.activeElement).toBe(hit);
  await unmount();
});

test("the shortcut cells name the prefix actions that really run", async () => {
  const actions = menuActions();
  const { unmount } = await render(<MenuHarness actions={actions} rows={[FIRST]} />);

  await prefixThen("e");
  await vi.waitFor(() => expect(actions.onRename).toHaveBeenCalledExactlyOnceWith(FIRST.id));
  await prefixThen("d");
  await vi.waitFor(() => expect(actions.onToggleSettle).toHaveBeenCalledExactlyOnceWith(FIRST.id));
  await unmount();
});

test("Remove task… reaches the real two-stage confirmation instead of removing at once", async () => {
  const onRemove = vi.fn<(force: boolean) => Promise<void>>(() => Promise.resolve());

  function RemoveHarness() {
    const [removeId, setRemoveId] = useState<string>();
    const actions = menuActions();
    return (
      <>
        <MenuHarness actions={{ ...actions, onRemove: setRemoveId }} rows={[FIRST]} />
        {removeId !== undefined && (
          <RemoveTaskDialog
            task={taskOf(FIRST)}
            onRemove={onRemove}
            onClose={() => setRemoveId(undefined)}
          />
        )}
      </>
    );
  }

  const { unmount } = await render(<RemoveHarness />);
  await openRowMenu(FIRST.title);
  await page.getByRole("menuitem", { name: "Remove task…" }).click();

  const dialog = page.getByRole("alertdialog");
  await expect.element(dialog).toBeVisible();
  await expect.element(dialog.getByRole("button", { name: "Cancel" })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(dialog).not.toBeInTheDocument();
  expect(onRemove).not.toHaveBeenCalled();

  await openRowMenu(FIRST.title);
  await page.getByRole("menuitem", { name: "Remove task…" }).click();
  await expect.element(dialog.getByRole("button", { name: "Cancel" })).toHaveFocus();
  await userEvent.keyboard("{Tab}{Enter}");
  await vi.waitFor(() => expect(onRemove).toHaveBeenCalledExactlyOnceWith(false));
  await unmount();
});
