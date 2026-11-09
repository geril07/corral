import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { useState } from "react";
import { render } from "vitest-browser-react";
import { prefixThen } from "../../../test/real-client.ts";
import { VISUAL_REVIEW_ROWS, VISUAL_REVIEW_SELECTED } from "./visual-fixtures.ts";
import { VisualShellView } from "./visual-view.tsx";

const SHORTCUT = { prefix: "alt+a", binding: "\\" };
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

test("keyboard focus opens metadata, Escape closes it, and right-click is left to the future menu", async () => {
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

test("hiding the sidebar animates its edge, reserves the Show toggle's chrome row, and restores focus", async () => {
  const { container, unmount } = await render(<Harness />);
  const aside = container.querySelector<HTMLElement>(".visual-shell-sidebar");
  const surface = container.querySelector<HTMLElement>(".visual-sidebar-surface");
  const chrome = container.querySelector<HTMLElement>(".visual-main-chrome");
  if (aside === null || surface === null || chrome === null) {
    throw new Error("sidebar frame is missing");
  }

  await userEvent.click(page.getByRole("button", { name: "Hide sidebar" }));
  await expect.poll(() => document.activeElement?.getAttribute("aria-label")).toBe("Show sidebar");
  await expect.poll(() => Math.round(aside.getBoundingClientRect().width)).toBe(0);
  // The contents keep the open width; the frame clips them instead of reflowing every frame.
  expect(Math.round(surface.getBoundingClientRect().width)).toBe(320);
  expect(chrome.getBoundingClientRect().height).toBe(40);

  const show = page.getByRole("button", { name: "Show sidebar" });
  const eyebrow = container.querySelector<HTMLElement>(".visual-main-eyebrow");
  if (eyebrow === null) throw new Error("main eyebrow is missing");
  const showBox = show.element().getBoundingClientRect();
  expect(showBox.bottom).toBeLessThanOrEqual(eyebrow.getBoundingClientRect().top);

  await userEvent.click(show);
  await expect
    .poll(() => document.activeElement?.getAttribute("data-task-id"))
    .toBe("fixture-blocked");
  await expect.poll(() => Math.round(aside.getBoundingClientRect().width)).toBe(320);
  expect(Math.round(surface.getBoundingClientRect().width)).toBe(320);
  await unmount();
});

test("a rapid hide/show reversal settles open with the saved width and focus", async () => {
  const { container, unmount } = await render(<Harness />);
  const aside = container.querySelector<HTMLElement>(".visual-shell-sidebar");
  if (aside === null) throw new Error("sidebar frame is missing");

  await userEvent.click(page.getByRole("button", { name: "Hide sidebar" }));
  const show = page.getByRole("button", { name: "Show sidebar" });
  await expect.element(show).toBeVisible();
  await userEvent.click(show);
  await expect.poll(() => Math.round(aside.getBoundingClientRect().width)).toBe(320);
  await expect
    .poll(() => document.activeElement?.getAttribute("data-task-id"))
    .toBe("fixture-blocked");
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
