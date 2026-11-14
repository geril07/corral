import type { ConnectionState } from "@corral/client/connection-state";
import { defaultClientConfig } from "@corral/protocol/config";
import type { Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { useState } from "react";
import { render } from "vitest-browser-react";
import type { VisualTaskRow } from "../../common/ui/index.ts";
import { removeClipboard, stubClipboard } from "../../../test/clipboard.ts";
import { prefixShifted, prefixThen } from "../../../test/real-client.ts";
import { KeymapProvider } from "../keymap/index.ts";
import { RemoveTaskDialog } from "../tasks/index.ts";
import {
  VISUAL_REVIEW_ROWS,
  VISUAL_REVIEW_SELECTED,
  VISUAL_REVIEW_SETTLED_ROWS,
} from "./visual-fixtures.ts";
import {
  VisualShellView,
  TaskMain,
  type VisualShellViewProps,
  type VisualTaskActions,
} from "./visual-view.tsx";

const SHORTCUT = { prefix: "alt+a", binding: "\\" };
const RENAME_SHORTCUT = { prefix: "alt+a", binding: "e" };
const REMOVE_SHORTCUT = { prefix: "alt+a", binding: "shift+t" };
const SETTLE_SHORTCUT = { prefix: "alt+a", binding: "d" };
const FOCUS_SHORTCUT = { prefix: "alt+a", binding: "w" };
/** No settled rows, as one stable value: an inline `[]` default would change on every render. */
const NO_SETTLED_ROWS: readonly VisualTaskRow[] = [];
const FIRST = VISUAL_REVIEW_ROWS[0]!;

for (const [status, line] of [
  [{ tone: "working", label: "Working" }, "Working"],
  [{ tone: "blocked", label: "Blocked", time: "2m" }, "Blocked · 2m ago"],
  [{ tone: "error", label: "Error", time: "1h" }, "Error · 1h ago"],
  [{ tone: "done", label: "Done", time: "4m" }, "Done · 4m ago"],
  [{ tone: "neutral", muted: true, time: "4m" }, "4m ago"],
  [{ tone: "neutral", label: "Idle", muted: true, time: "6h" }, "Idle · 6h ago"],
] satisfies [NonNullable<VisualTaskRow["status"]>, string][]) {
  test(`the header shows ${line} without explanatory clauses or the prompt`, async () => {
    const { container } = await render(<TaskMain row={{ ...FIRST, status }} />);
    expect(container.querySelector(".visual-main-status")?.textContent).toBe(line);
    expect(container.textContent).not.toContain("Last reported");
    expect(container.textContent).not.toContain("start time not available");
    expect(container.querySelector(".visual-main-prompt")).toBeNull();
    expect(getComputedStyle(container.querySelector(".visual-main-task")!).flexDirection).toBe(
      "row",
    );
  });
}

for (const scale of [100, 140]) {
  test(`the fallback identity row stays at its natural height and content top at ${scale}%`, async () => {
    const previousScale = document.documentElement.style.fontSize;
    document.documentElement.style.fontSize = `${scale}%`;
    try {
      const { container } = await render(
        <VisualShellView
          rows={[FIRST]}
          selectedId={FIRST.id}
          projectsLoaded
          tasksLoaded
          failure={undefined}
          shortcut={undefined}
          onSelectTask={() => undefined}
        />,
      );
      const content = container.querySelector<HTMLElement>(".visual-main-content")!;
      const identity = container.querySelector<HTMLElement>(".visual-main-task")!;
      const contentBox = content.getBoundingClientRect();
      const identityBox = identity.getBoundingClientRect();
      expect(getComputedStyle(identity).flexGrow).toBe("0");
      expect(identityBox.height).toBeLessThan(contentBox.height / 2);
      expect(identityBox.top).toBeCloseTo(
        contentBox.top + Number.parseFloat(getComputedStyle(content).paddingTop),
        0,
      );
      expect(getComputedStyle(identity).flexDirection).toBe("row");
    } finally {
      document.documentElement.style.fontSize = previousScale;
    }
  });
}

test("a settled task keeps the live Working status beside its shelf marker", async () => {
  const { container } = await render(
    <TaskMain row={{ ...FIRST, settled: true, status: { tone: "working", label: "Working" } }} />,
  );
  expect(container.querySelector(".visual-main-status")?.textContent).toBe("Working");
  expect(container.querySelector(".visual-main-settled")?.textContent).toBe("Settled");
});

test("an idle row and selected header retain Idle and their age", async () => {
  const row: VisualTaskRow = {
    ...FIRST,
    status: { tone: "neutral", label: "Idle", time: "6h", muted: true },
  };
  const { container } = await render(
    <VisualShellView
      rows={[row]}
      selectedId={row.id}
      projectsLoaded
      tasksLoaded
      hasProjects
      shortcut={undefined}
      failure={undefined}
      onSelectTask={() => undefined}
    />,
  );
  expect(container.querySelector(".visual-task-status-label")?.textContent).toBe("Idle");
  expect(container.querySelector(".visual-task-status-time")?.textContent).toBe("6h");
  expect(container.querySelector(".visual-main-status")?.textContent).toBe("Idle · 6h ago");
});

for (const hasProjects of [false, true]) {
  for (const failure of [undefined, "Server unavailable"]) {
    test(`sidebar and main share ${failure ? "failure" : "empty"} sentences with projects=${hasProjects}`, async () => {
      const { container } = await render(
        <VisualShellView
          rows={[]}
          selectedId={null}
          projectsLoaded
          tasksLoaded
          hasProjects={hasProjects}
          shortcut={undefined}
          failure={failure}
          onSelectTask={() => undefined}
        />,
      );
      const title = failure ? "The workspace could not load." : "No active tasks.";
      const detail =
        failure ??
        (hasProjects
          ? "Start one with New task."
          : "Add a project, or start without one with New task.");
      for (const selector of [".visual-list-state", ".visual-main-empty"]) {
        const block = container.querySelector(selector);
        expect(block?.textContent).toBe(title + detail);
        expect(block?.querySelectorAll("span")).toHaveLength(2);
      }
    });
  }
}

function Harness({
  status,
  onFindTask,
}: {
  status?: VisualShellViewProps["status"];
  onFindTask?: (() => void) | undefined;
} = {}) {
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
      onFindTask={onFindTask}
      findTaskShortcut={onFindTask === undefined ? undefined : { prefix: "alt+a", binding: "f" }}
      status={status}
    />
  );
}

function cardButton(index: number) {
  return page.getByRole("button", { name: new RegExp(VISUAL_REVIEW_ROWS[index]!.title) });
}

function menuActions() {
  return {
    onRename: vi.fn<(id: string) => void>(),
    onRemove: vi.fn<(id: string) => void>(),
    onViewSource: vi.fn<(id: string) => void>(),
    onToggleSettle: vi.fn<(id: string) => Promise<boolean>>(() => Promise.resolve(true)),
  };
}

function MenuHarness({
  actions,
  rows = VISUAL_REVIEW_ROWS,
  settledRows = NO_SETTLED_ROWS,
  composerOpen = false,
  selectedId,
}: {
  actions: VisualTaskActions;
  rows?: readonly VisualTaskRow[];
  settledRows?: readonly VisualTaskRow[];
  composerOpen?: boolean;
  /** The selection a route would name on load; absent starts on the first active row. */
  selectedId?: string | null | undefined;
}) {
  const [selected, setSelected] = useState<string | null>(
    selectedId === undefined ? (rows[0]?.id ?? null) : selectedId,
  );
  return (
    <VisualShellView
      rows={rows}
      settledRows={settledRows}
      selectedId={selected}
      projectsLoaded
      tasksLoaded
      failure={undefined}
      shortcut={SHORTCUT}
      renameShortcut={RENAME_SHORTCUT}
      removeShortcut={REMOVE_SHORTCUT}
      settleShortcut={SETTLE_SHORTCUT}
      focusSidebarShortcut={FOCUS_SHORTCUT}
      taskActions={actions}
      composerOpen={composerOpen}
      onSelectTask={setSelected}
    />
  );
}

async function openRowMenu(title: string) {
  const card = page.getByRole("button", { name: new RegExp(title) });
  await userEvent.click(card, { button: "right" });
  await expect.element(page.getByRole("menu")).toBeVisible();
  // One popup at a time: the mouse path also clears the metadata tooltip.
  await expect.poll(() => document.querySelector('[role="tooltip"]')).toBeNull();
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

const copyNotice = () => document.querySelector(".visual-shell-notice-message")?.textContent;

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
    state: "active",
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

test("hover/focus swaps the status slot for the Settle action without moving the title", async () => {
  const { container, unmount } = await render(<MenuHarness actions={menuActions()} />);
  const first = container.querySelector(".visual-task-card");
  if (!(first instanceof HTMLElement)) throw new Error("first card is missing");
  const action = first.querySelector<HTMLElement>(".visual-task-slot-action");
  if (action === null) throw new Error("action slot is missing");
  expect(getComputedStyle(action).opacity).toBe("0");

  await userEvent.click(cardButton(0));
  await expect.poll(() => getComputedStyle(action).opacity).toBe("1");
  const settle = first.querySelector<HTMLButtonElement>(".visual-task-action");
  expect(settle?.getAttribute("aria-label")).toBe("Settle task");
  expect(settle?.getAttribute("aria-disabled")).toBeNull();
  await unmount();
});

test("a host with no task store keeps the status instead of offering a settle action", async () => {
  const { container, unmount } = await render(<Harness />);
  await userEvent.click(cardButton(0));
  const first = container.querySelector(".visual-task-card");
  if (!(first instanceof HTMLElement)) throw new Error("first card is missing");
  expect(first.querySelector(".visual-task-action")).toBeNull();
  expect(first.querySelector(".visual-task-status")).not.toBeNull();
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
  const newTask = page.getByRole("button", { name: "New task" });
  await userEvent.hover(newTask);
  await nextFrame();
  expect(tooltipText() ?? "").not.toContain("Creating tasks is unavailable here.");
  await expect.poll(tooltipText).toContain("Creating tasks is unavailable here.");
  await unmount();
});

test("the card status strip is not a pointer dead zone, and Settle replaces rather than conflicts", async () => {
  const { container, unmount } = await render(<MenuHarness actions={menuActions()} />);
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

test("an unavailable action stacks its title over its reason instead of using columns", async () => {
  const { unmount } = await render(<Harness />);
  const newTask = page.getByRole("button", { name: "New task" }).element();
  if (!(newTask instanceof HTMLElement)) throw new Error("New task control is missing");

  await userEvent.hover(newTask);
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
  expect(reasonBox.height).toBeGreaterThanOrEqual(15);

  const before = getComputedStyle(newTask).backgroundColor;
  await userEvent.unhover(newTask);
  await expect.poll(() => getComputedStyle(newTask).backgroundColor).not.toBe(before);
  expect(getComputedStyle(newTask).cursor).toBe("not-allowed");
  await unmount();
});

const STATUS_CONFIG = {
  loaded: true,
  path: "",
  exists: false,
  config: defaultClientConfig("/tmp"),
  profiles: [],
  agents: [],
  problems: [],
};

test("the connection banner sits above the working area and the sidebar has no status", async () => {
  const opened: HTMLElement[] = [];
  const retried = vi.fn<() => void>();
  const disconnected: ConnectionState = {
    status: "disconnected",
    attempt: 2,
    startedAt: Date.now(),
  };
  const { unmount } = await render(
    <KeymapProvider config={STATUS_CONFIG}>
      <Harness
        status={{
          connection: disconnected,
          onOpenConnection: (opener) => opened.push(opener),
          onRetryConnection: retried,
          onOpenConfigProblems: () => undefined,
        }}
      />
    </KeymapProvider>,
  );

  // The banner waits out the reconnect grace, then names the server above the workspace.
  await vi.waitFor(
    () => expect(document.querySelector('[data-slot="connection-banner"]')).not.toBeNull(),
    { timeout: 3000 },
  );
  const banner = document.querySelector<HTMLElement>('[data-slot="connection-banner"]')!;
  expect(banner.closest("main")).toBe(page.getByRole("main", { name: "Workspace" }).element());
  await expect.element(page.getByText(/^Cannot reach the server · /)).toBeVisible();

  // The sidebar keeps its actions and carries no connection word, icon or opener.
  const footer = document.querySelector('[data-slot="shell-status"][data-placement="footer"]')!;
  expect(footer.querySelector('[data-slot="connection-banner"]')).toBeNull();
  expect(footer.textContent).not.toContain("Cannot reach the server");
  expect(page.getByRole("button", { name: /^connection:/ }).elements()).toHaveLength(0);
  await expect.element(page.getByRole("button", { name: "Settings" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Add project" })).toBeVisible();

  await page.getByRole("button", { name: "Retry now" }).click();
  expect(retried).toHaveBeenCalledOnce();
  const details = page.getByRole("button", { name: "Details" });
  await details.click();
  expect(opened).toEqual([details.element()]);

  // Hiding the sidebar leaves one banner in the same place, not a second copy in the strip.
  await userEvent.click(page.getByRole("button", { name: "Hide sidebar" }));
  await expect.element(page.getByText(/^Cannot reach the server · /)).toBeVisible();
  expect(document.querySelectorAll('[data-slot="connection-banner"]')).toHaveLength(1);
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
  // The frame's rounded width can reach 320 before ResizeObserver positions the toggle.
  await expect
    .poll(() =>
      Math.abs(toggles()[0]!.getBoundingClientRect().left - openSlot.getBoundingClientRect().left),
    )
    .toBeLessThan(1);
  expect(
    Math.abs(toggles()[0]!.getBoundingClientRect().top - openSlot.getBoundingClientRect().top),
  ).toBeLessThan(1);
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

test("Search sits in the sidebar action row and answers its prefix chord", async () => {
  const onFindTask = vi.fn<() => void>();
  const { unmount } = await render(<Harness onFindTask={onFindTask} />);
  const search = page.getByRole("button", { name: "Search tasks…" });
  await expect.element(search).toBeVisible();
  await userEvent.click(search);
  expect(onFindTask).toHaveBeenCalledOnce();

  await prefixThen("f");
  expect(onFindTask).toHaveBeenCalledTimes(2);
  await unmount();
});

test("unavailable actions say why in the compact tooltip and never claim to run", async () => {
  const { unmount } = await render(<Harness />);
  const newTask = page.getByRole("button", { name: "New task" });
  await expect.element(newTask).toHaveAttribute("aria-disabled", "true");
  await userEvent.hover(newTask);
  const tooltip = page.getByRole("tooltip");
  await expect.element(tooltip).toBeVisible();
  await expect.element(tooltip).toMatchTextContent("Creating tasks is unavailable here.");

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
  expect(shortcutCells()).toEqual(["alt+a e", "alt+a d", "alt+a shift+t"]);
  expect(
    page
      .getByRole("menuitem", { name: "Rename task…" })
      .element()
      .getAttribute("aria-keyshortcuts"),
  ).toBe("alt+a e");
  expect(
    page.getByRole("menuitem", { name: "Settle task" }).element().getAttribute("aria-keyshortcuts"),
  ).toBe("alt+a d");

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

test("a host with no settle action offers no item and no card action", async () => {
  const actions = menuActions();
  const withoutStore: VisualTaskActions = {
    onRename: actions.onRename,
    onRemove: actions.onRemove,
    onViewSource: actions.onViewSource,
  };
  const { container, unmount } = await render(
    <MenuHarness actions={withoutStore} rows={[FIRST]} />,
  );

  await openRowMenu(FIRST.title);
  expect(page.getByRole("menuitem", { name: /Settle task|Unsettle task/ }).elements()).toHaveLength(
    0,
  );
  await userEvent.keyboard("{Escape}");
  expect(container.querySelector(".visual-task-action")).toBeNull();
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

test("clipboard refusal is visible in the task notice", async () => {
  const clipboard = stubClipboard(() =>
    Promise.reject(new Error("The system denied clipboard access.")),
  );
  try {
    const { unmount } = await render(<MenuHarness actions={menuActions()} rows={[FIRST]} />);
    await openRowMenu(FIRST.title);
    await page.getByRole("menuitem", { name: "Copy" }).click();
    await page.getByRole("menuitem", { name: "Copy workspace path" }).click();
    await vi.waitFor(() => expect(copyNotice()).toBe("The system denied clipboard access."));
    await expect.element(page.getByRole("alert")).toBeVisible();
    await unmount();
  } finally {
    clipboard.restore();
  }
});

test("an unavailable clipboard is reported instead of claiming a copy", async () => {
  const clipboard = removeClipboard();
  try {
    const { unmount } = await render(<MenuHarness actions={menuActions()} rows={[FIRST]} />);
    await openRowMenu(FIRST.title);
    await page.getByRole("menuitem", { name: "Copy" }).click();
    await page.getByRole("menuitem", { name: "Copy workspace path" }).click();
    await vi.waitFor(() => expect(copyNotice()).toBe("Clipboard access is unavailable."));
    await expect.element(page.getByRole("alert")).toBeVisible();
    await unmount();
  } finally {
    clipboard.restore();
  }
});

test("a task without a branch has no Branch item under Copy, and the other items stay", async () => {
  const actions = menuActions();
  const branchless: VisualTaskRow = {
    ...FIRST,
    copyBranch: undefined,
    metadata: { ...FIRST.metadata, branch: undefined },
  };
  const screen = await render(<MenuHarness actions={actions} rows={[branchless]} />);

  await openRowMenu(FIRST.title);
  await page.getByRole("menuitem", { name: "Copy" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Copy workspace path" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Copy task ID" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Copy branch" })).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}{Escape}");

  // A detached create records "HEAD"; the row carries no branch name to copy.
  const detached: VisualTaskRow = {
    ...FIRST,
    copyBranch: undefined,
    metadata: { ...FIRST.metadata, branch: "HEAD" },
  };
  await screen.rerender(<MenuHarness actions={actions} rows={[detached]} />);
  await openRowMenu(FIRST.title);
  await page.getByRole("menuitem", { name: "Copy" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Copy branch" })).not.toBeInTheDocument();
  await screen.unmount();
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
  await prefixShifted("t");
  await vi.waitFor(() => expect(actions.onRemove).toHaveBeenCalledExactlyOnceWith(FIRST.id));
  await unmount();
});

test("row chords stay silent while a composer draft is open", async () => {
  const actions = menuActions();
  const screen = await render(<MenuHarness actions={actions} rows={[FIRST]} composerOpen />);

  await prefixThen("e");
  await prefixShifted("t");
  expect(actions.onRename).not.toHaveBeenCalled();
  expect(actions.onRemove).not.toHaveBeenCalled();

  await screen.rerender(<MenuHarness actions={actions} rows={[FIRST]} composerOpen={false} />);
  await prefixThen("e");
  await vi.waitFor(() => expect(actions.onRename).toHaveBeenCalledExactlyOnceWith(FIRST.id));
  await screen.unmount();
});

test("the Settled shelf names its count, opens from the keyboard and keeps the current row alone when closed", async () => {
  const actions = menuActions();
  const settled = VISUAL_REVIEW_SETTLED_ROWS;
  const screen = await render(
    <MenuHarness actions={actions} rows={VISUAL_REVIEW_ROWS} settledRows={settled} />,
  );

  const toggle = page.getByRole("button", { name: "Settled (2)" });
  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  // Collapsed: none of the history is mounted, and the active list is untouched.
  expect(document.querySelector(`[data-task-id="${settled[0]!.id}"]`)).toBeNull();
  expect(
    document
      .querySelector<HTMLElement>('[data-task-id="fixture-blocked"]')
      ?.getAttribute("aria-current"),
  ).toBe("true");

  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
  await expect
    .element(page.getByRole("button", { name: new RegExp(settled[0]!.title) }))
    .toBeVisible();
  await expect
    .element(page.getByRole("button", { name: new RegExp(settled[1]!.title) }))
    .toBeVisible();
  // The shelf's rows are the same card recipe, in the shelf's one order.
  const shelfRows = [...document.querySelectorAll<HTMLElement>(".visual-shelf [data-task-id]")];
  expect(shelfRows.map((row) => row.getAttribute("data-task-id"))).toEqual(
    settled.map((row) => row.id),
  );
  // The disclosure names the list it opens, in every state.
  const list = document.getElementById(toggle.element().getAttribute("aria-controls") ?? "");
  expect(list?.tagName).toBe("UL");
  expect(list?.getAttribute("aria-label")).toBe("Settled tasks");
  await screen.unmount();
});

test("an expanded shelf reveals the current row when the selection arrives from outside", async () => {
  const settled = Array.from({ length: 30 }, (_, index) => ({
    ...VISUAL_REVIEW_ROWS[0]!,
    id: `fixture-settled-${index}`,
    title: `Settled row ${index}`,
    settled: true,
  }));
  const last = settled.at(-1)!;
  // The device preference from a prior visit: the shelf is already open when the route names a task.
  window.localStorage.setItem("corral.sidebar-shelf", JSON.stringify({ expanded: true, page: 2 }));

  const { container, unmount } = await render(
    <MenuHarness actions={menuActions()} rows={[]} settledRows={settled} selectedId={last.id} />,
  );
  await expect
    .element(page.getByRole("button", { name: "Settled (30)" }))
    .toHaveAttribute("aria-expanded", "true");
  const row = container.querySelector<HTMLElement>(`[data-task-id="${last.id}"]`);
  const scroller = container.querySelector<HTMLElement>(".visual-task-scroll");
  if (row === null || scroller === null) throw new Error("the shelf is missing its scroller");
  expect(row.getAttribute("aria-current")).toBe("true");

  const rowBox = row.getBoundingClientRect();
  const scrollerBox = scroller.getBoundingClientRect();
  expect(rowBox.top).toBeGreaterThanOrEqual(scrollerBox.top - 1);
  expect(rowBox.bottom).toBeLessThanOrEqual(scrollerBox.bottom + 1);
  await unmount();
});

test("the shelf's writer keeps the prior sidebar's page in the shared device preference", async () => {
  window.localStorage.setItem("corral.sidebar-shelf", JSON.stringify({ expanded: false, page: 2 }));
  const { unmount } = await render(
    <MenuHarness
      actions={menuActions()}
      rows={VISUAL_REVIEW_ROWS}
      settledRows={VISUAL_REVIEW_SETTLED_ROWS}
    />,
  );

  await page.getByRole("button", { name: "Settled (2)" }).click();
  expect(JSON.parse(window.localStorage.getItem("corral.sidebar-shelf") ?? "null")).toEqual({
    expanded: true,
    page: 2,
  });
  await unmount();
});

test("prefix w shows a hidden sidebar and gives its list the keyboard", async () => {
  const { unmount } = await render(<MenuHarness actions={menuActions()} />);
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect.element(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();

  await prefixThen("w");
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute("data-task-id")).toBe(VISUAL_REVIEW_ROWS[0]!.id),
  );
  await expect.element(page.getByRole("button", { name: "Hide sidebar" })).toBeVisible();
  await unmount();
});

test("the keyboard reaches the shelf, opens it, and selects a settled task without a pointer", async () => {
  const actions = menuActions();
  const settled = VISUAL_REVIEW_SETTLED_ROWS;
  const { unmount } = await render(
    <MenuHarness actions={actions} rows={VISUAL_REVIEW_ROWS} settledRows={settled} />,
  );

  // `prefix w` gives the list the keyboard, on the current row.
  await prefixThen("w");
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute("data-task-id")).toBe(VISUAL_REVIEW_ROWS[0]!.id),
  );
  // Arrows walk the active rows, then the shelf's disclosure.
  for (let step = 1; step < VISUAL_REVIEW_ROWS.length; step += 1) {
    await userEvent.keyboard("{ArrowDown}");
    await vi.waitFor(() =>
      expect(document.activeElement?.getAttribute("data-task-id")).toBe(
        VISUAL_REVIEW_ROWS[step]!.id,
      ),
    );
  }
  await userEvent.keyboard("{ArrowDown}");
  const toggle = page.getByRole("button", { name: `Settled (${settled.length})` });
  await vi.waitFor(() => expect(document.activeElement).toBe(toggle.element()));

  await userEvent.keyboard("{Enter}");
  await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
  await userEvent.keyboard("{ArrowDown}");
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute("data-task-id")).toBe(settled[0]!.id),
  );
  // The settled row is the current one, and its working area names the state.
  await expect.element(page.getByRole("heading", { name: settled[0]!.title })).toBeVisible();
  await expect.element(page.getByText("Settled", { exact: true })).toBeVisible();

  // `prefix d` continues it: the same action the row's menu and card offer.
  await prefixThen("d");
  await vi.waitFor(() =>
    expect(actions.onToggleSettle).toHaveBeenCalledExactlyOnceWith(settled[0]!.id),
  );
  await unmount();
});

test("a settled task's row is current, keeps its status slot, and its menu and card unsettle it", async () => {
  const actions = menuActions();
  const settled = VISUAL_REVIEW_SETTLED_ROWS[0]!;
  function SettledHarness() {
    const [selected, setSelected] = useState<string | null>(settled.id);
    return (
      <VisualShellView
        rows={VISUAL_REVIEW_ROWS}
        settledRows={[settled]}
        selectedId={selected}
        projectsLoaded
        tasksLoaded
        failure={undefined}
        shortcut={SHORTCUT}
        taskActions={actions}
        onSelectTask={setSelected}
      />
    );
  }
  const { container, unmount } = await render(<SettledHarness />);

  // The current settled task is shown by its own row, and no active row claims the marker.
  const row = container.querySelector<HTMLElement>(`[data-task-id="${settled.id}"]`);
  expect(row?.getAttribute("aria-current")).toBe("true");
  expect(
    container
      .querySelector<HTMLElement>('[data-task-id="fixture-blocked"]')
      ?.getAttribute("aria-current"),
  ).toBeNull();
  // The working area names the server-owned state; the row keeps its status slot.
  await expect.element(page.getByRole("heading", { name: settled.title })).toBeVisible();
  await expect.element(page.getByText("Settled", { exact: true })).toBeVisible();
  expect(row?.closest(".visual-task-card")?.getAttribute("data-settled")).toBe("true");
  expect(row?.closest(".visual-task-card")?.querySelector(".visual-task-status")).not.toBeNull();

  await userEvent.click(page.getByRole("button", { name: new RegExp(settled.title) }), {
    button: "right",
  });
  await page.getByRole("menuitem", { name: "Unsettle task" }).click();
  expect(actions.onToggleSettle).toHaveBeenCalledExactlyOnceWith(settled.id);

  // The card's hover action is the same action, named for the state it leaves.
  const action = row
    ?.closest(".visual-task-card")
    ?.querySelector<HTMLButtonElement>(".visual-task-action");
  expect(action?.getAttribute("aria-label")).toBe("Unsettle task");
  action?.click();
  expect(actions.onToggleSettle).toHaveBeenLastCalledWith(settled.id);
  await unmount();
});

test("the settle action is a real command: the card and prefix d call it, and no confirmation appears", async () => {
  const actions = menuActions();
  const { container, unmount } = await render(<MenuHarness actions={actions} rows={[FIRST]} />);

  const action = container.querySelector<HTMLButtonElement>(".visual-task-action");
  if (action === null) throw new Error("the settle action is missing");
  action.click();
  expect(actions.onToggleSettle).toHaveBeenCalledExactlyOnceWith(FIRST.id);

  await prefixThen("d");
  await vi.waitFor(() => expect(actions.onToggleSettle).toHaveBeenCalledTimes(2));
  expect(actions.onToggleSettle).toHaveBeenLastCalledWith(FIRST.id);
  expect(page.getByRole("alertdialog").elements()).toHaveLength(0);
  await unmount();
});

/** No moved rows, as one stable value: an inline `[]` default would change on every render. */
const NO_MOVED_ROWS: readonly string[] = [];

/**
 * The shelf's real mechanics for one device: the host moves the row between the two lists and
 * reports the server's answer. `refuse` keeps the state where it is, as a server refusal does;
 * `still` reports success without moving, as a server that already had the state does; `moved` is
 * a change made elsewhere (another client, a restart).
 */
function ShelfHarness({
  refuse = false,
  still = false,
  moved = NO_MOVED_ROWS,
}: {
  refuse?: boolean;
  still?: boolean;
  moved?: readonly string[];
}) {
  const [settledIds, setSettledIds] = useState<readonly string[]>([]);
  const [selected, setSelected] = useState<string | null>(VISUAL_REVIEW_ROWS[0]!.id);
  const settledNow = new Set([...settledIds, ...moved]);
  const actions: VisualTaskActions = {
    onRename: () => undefined,
    onRemove: () => undefined,
    onViewSource: () => undefined,
    onToggleSettle: async (id) => {
      if (refuse) return false;
      if (still) return true;
      setSettledIds((current) =>
        current.includes(id) ? current.filter((each) => each !== id) : [...current, id],
      );
      return true;
    },
  };
  return (
    <VisualShellView
      rows={VISUAL_REVIEW_ROWS.filter((row) => !settledNow.has(row.id))}
      settledRows={VISUAL_REVIEW_ROWS.filter((row) => settledNow.has(row.id))}
      selectedId={selected}
      projectsLoaded
      tasksLoaded
      failure={undefined}
      shortcut={SHORTCUT}
      settleShortcut={SETTLE_SHORTCUT}
      taskActions={actions}
      onSelectTask={setSelected}
    />
  );
}

test("settling from the row menu hands the keyboard to the row in its new home", async () => {
  const { container, unmount } = await render(<ShelfHarness />);
  const hit = container.querySelector<HTMLElement>(`[data-task-id="${FIRST.id}"]`);
  if (hit === null) throw new Error("the card is missing");

  hit.focus();
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  await page.getByRole("menuitem", { name: "Settle task" }).click();

  // The menu lives in a portal, so this path must record the move without asking where focus was.
  await expect.element(page.getByRole("button", { name: "Settled (1)" })).toBeVisible();
  await vi.waitFor(() =>
    expect(document.activeElement?.getAttribute("data-task-id")).toBe(FIRST.id),
  );
  expect(document.activeElement?.closest(".visual-shelf")).not.toBeNull();
  await unmount();
});

test("a refused settle leaves no focus intent behind", async () => {
  const screen = await render(<ShelfHarness refuse />);
  const hit = screen.container.querySelector<HTMLElement>(`[data-task-id="${FIRST.id}"]`);
  if (hit === null) throw new Error("the card is missing");

  hit.focus();
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  await page.getByRole("menuitem", { name: "Settle task" }).click();
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();

  // The user moves on, then the row moves for another reason: the keyboard must stay put.
  const elsewhere = page.getByRole("button", { name: "Hide sidebar" }).element();
  if (!(elsewhere instanceof HTMLElement)) throw new Error("the toggle is missing");
  elsewhere.focus();
  await screen.rerender(<ShelfHarness refuse moved={[FIRST.id]} />);
  await nextFrame();
  expect(document.activeElement).toBe(elsewhere);
  await expect.element(page.getByRole("button", { name: "Settled (1)" })).toBeVisible();
  await screen.unmount();
});

test("a settle that reports success without moving cannot take the keyboard later", async () => {
  // The server already had the target state, so it answered early and notified nobody; another
  // window's watch may still land later.
  const screen = await render(<ShelfHarness still />);
  const hit = screen.container.querySelector<HTMLElement>(`[data-task-id="${FIRST.id}"]`);
  if (hit === null) throw new Error("the card is missing");

  hit.focus();
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  await page.getByRole("menuitem", { name: "Settle task" }).click();
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();

  // The user moves on with a key of their own; the intent must end there.
  const elsewhere = page.getByRole("button", { name: "Hide sidebar" }).element();
  if (!(elsewhere instanceof HTMLElement)) throw new Error("the toggle is missing");
  elsewhere.focus();
  await userEvent.keyboard("{Escape}");
  await screen.rerender(<ShelfHarness still moved={[FIRST.id]} />);
  await nextFrame();
  expect(document.activeElement).toBe(elsewhere);
  await expect.element(page.getByRole("button", { name: "Settled (1)" })).toBeVisible();
  await screen.unmount();
});

test("a copy confirmation clears on the next interaction", async () => {
  const clipboard = stubClipboard(async () => undefined);
  try {
    const actions = menuActions();
    const { unmount } = await render(<MenuHarness actions={actions} rows={[FIRST]} />);

    await openRowMenu(FIRST.title);
    await page.getByRole("menuitem", { name: "Copy" }).click();
    await page.getByRole("menuitem", { name: "Copy workspace path" }).click();
    await vi.waitFor(() => expect(copyNotice()).toBe("Workspace path copied"));

    await userEvent.click(cardButton(0));
    await expect.poll(copyNotice).toBeUndefined();
    await unmount();
  } finally {
    clipboard.restore();
  }
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
