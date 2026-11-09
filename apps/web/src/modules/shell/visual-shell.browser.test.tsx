import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { useState } from "react";
import { render } from "vitest-browser-react";
import { prefixThen } from "../../../test/real-client.ts";
import { VISUAL_REVIEW_ROWS, VISUAL_REVIEW_SELECTED } from "./visual-fixtures.ts";
import { VisualShellView } from "./visual-view.tsx";

const SHORTCUT = { prefix: "alt+a", binding: "\\" };

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

test("a card selects the task, and ArrowDown moves selection and focus", async () => {
  const { container, unmount } = await render(<Harness />);
  await expect
    .element(page.getByRole("heading", { name: VISUAL_REVIEW_ROWS[0]!.title }))
    .toBeVisible();

  await userEvent.click(
    page.getByRole("button", { name: new RegExp(VISUAL_REVIEW_ROWS[2]!.title) }),
  );
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

  await expect
    .element(page.getByRole("button", { name: new RegExp(VISUAL_REVIEW_ROWS[0]!.title) }))
    .toBeVisible();
  await userEvent.click(
    page.getByRole("button", { name: new RegExp(VISUAL_REVIEW_ROWS[0]!.title) }),
  );
  await expect.poll(() => getComputedStyle(action).opacity).toBe("1");
  const settle = first.querySelector<HTMLButtonElement>(".visual-task-action");
  expect(settle?.getAttribute("aria-disabled")).toBe("true");
  expect(settle?.hasAttribute("disabled")).toBe(false);
  await unmount();
});

test("the toggle hides the sidebar, stays available in the main surface, and its tooltip uses the live keymap", async () => {
  const { unmount } = await render(<Harness />);
  const hide = page.getByRole("button", { name: "Hide sidebar" });
  await expect.element(hide).toBeVisible();
  await userEvent.click(hide);

  await expect.element(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Hide sidebar" })).not.toBeInTheDocument();

  await prefixThen("\\");
  await expect.element(page.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
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
