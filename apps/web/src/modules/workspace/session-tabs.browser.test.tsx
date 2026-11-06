import { sessionLabels } from "@corral/client/session-labels";
import type { SessionEntry } from "@corral/client/workspace-tree";
import {
  DEFAULT_BINDINGS,
  DEFAULT_PREFIX,
  defaultClientConfig,
  type ClientConfig,
} from "@corral/protocol/config";
import type { AgentStatus, Session } from "@corral/protocol/rpc";
import { useState } from "react";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { SessionTabs } from "./session-tabs.tsx";

const session = (
  id: string,
  kind: Session["kind"],
  status: AgentStatus | null = null,
  state: Session["state"] = "running",
): Session => ({
  id,
  taskId: "a",
  kind,
  view: "terminal",
  agentSessionId: null,
  terminalId: state === "running" ? `term-${id}` : null,
  state,
  status,
  createdAt: Number(id.replace(/\D/g, "")),
});

const entry = (value: Session): SessionEntry => ({
  type: "session",
  id: value.id,
  session: value,
  terminal: undefined,
});

const config: ClientConfig = {
  ...defaultClientConfig(""),
  keys: { prefix: DEFAULT_PREFIX, bindings: { ...DEFAULT_BINDINGS } },
};

const defaultSessions = [
  session("s1", "shell"),
  session("s2", "claude"),
  session("s3", "codex", null, "stopped"),
];

function renderTabs(
  sessions: Session[] = defaultSessions,
  currentId = "s3",
  overrides: Partial<Parameters<typeof SessionTabs>[0]> = {},
) {
  const entries = sessions.map(entry);
  const props = {
    entries,
    labels: sessionLabels(sessions),
    currentId,
    config,
    onSelect: vi.fn<(entry: SessionEntry) => void>(),
    onStop: vi.fn<(session: Session) => void>(),
    onRestart: vi.fn<(session: Session) => void>(),
    onRemove: vi.fn<(session: Session) => void>(),
    onRename: vi.fn<(entry: SessionEntry, opener?: HTMLElement) => void>(),
    onNewShell: vi.fn<() => void>(),
    onNewAgent: vi.fn<(opener?: HTMLElement) => void>(),
    ...overrides,
  };
  // The selection lives in the strip's caller, as it does in the workspace; the harness keeps it
  // so the tests read the rendered selection instead of only the callback.
  function Harness() {
    const [selected, setSelected] = useState(currentId);
    return (
      <SessionTabs
        {...props}
        currentId={selected}
        onSelect={(selectedEntry) => {
          props.onSelect(selectedEntry);
          setSelected(selectedEntry.id);
        }}
      />
    );
  }
  const rendered = render(<Harness />);
  return { rendered, props };
}

const strip = () => page.getByRole("tablist", { name: "Sessions" });
const tab = (name: string) => strip().getByRole("tab", { name });

test("one tab per session, in creation order, numbered for the first nine", async () => {
  await renderTabs(
    Array.from({ length: 10 }, (_, index) => session(`s${index + 1}`, "shell")),
    "s1",
  ).rendered;

  // A classic scrollbar would eat the 32 px strip; the kit's utility hides it.
  expect(getComputedStyle(strip().element()).scrollbarWidth).toBe("none");

  const tabs = strip().getByRole("tab").elements();
  expect(tabs).toHaveLength(10);
  expect(tabs[0]?.textContent).toBe("1shell");
  expect(tabs[8]?.textContent).toBe("9shell 9");
  // The tenth has no chord to name it, so it shows no number.
  expect(tabs[9]?.textContent).toBe("shell 10");
});

test("a kind that appears more than once is numbered, and a renamed session keeps its name", async () => {
  const { rendered } = renderTabs(
    [
      session("s1", "shell"),
      session("s2", "shell"),
      { ...session("s3", "claude"), label: "reviewer" },
    ],
    "s1",
  );
  await rendered;

  await expect.element(tab("shell")).toBeVisible();
  await expect.element(tab("shell 2")).toBeVisible();
  await expect.element(tab("reviewer")).toBeVisible();
});

test("the status glyph replaces the kind icon while working or blocked", async () => {
  const { rendered } = renderTabs(
    [
      session("s1", "claude", { state: "working", updatedAt: 1 }),
      session("s2", "codex", { state: "blocked", kind: "question", updatedAt: 2 }),
      session("s3", "pi", { state: "done", updatedAt: 3 }),
      session("s4", "shell"),
    ],
    "s1",
  );
  await rendered;

  const glyphs = [...strip().element().querySelectorAll("[data-status]")];
  expect(glyphs.map((each) => each.getAttribute("data-status"))).toEqual(["working", "blocked"]);
  // A finished or idle session shows what it is, not a status glyph.
  await expect.element(tab("pi")).toBeVisible();

  // Both the kind icon and the status glyph are 14 px, so a tab does not shift when it starts working.
  const sizes = [...strip().element().querySelectorAll('[role="tab"]')].map(
    (each) => each.querySelector("svg")!.getBoundingClientRect().width,
  );
  expect(sizes).toEqual([14, 14, 14, 14]);
});

test("the selected tab is marked and pressing another one selection follows it", async () => {
  const { rendered, props } = renderTabs(undefined, "s2");
  await rendered;

  await expect.element(tab("claude")).toHaveAttribute("aria-selected", "true");
  await expect.element(tab("shell")).toHaveAttribute("aria-selected", "false");

  await tab("shell").click();
  await expect.element(tab("shell")).toHaveAttribute("aria-selected", "true");
  await expect.element(tab("claude")).toHaveAttribute("aria-selected", "false");
  expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
});

test("the strip's own keys move the selection and wrap", async () => {
  const { rendered } = renderTabs(undefined, "s2");
  await rendered;

  // Focus stays where the keyboard was (`ux.md`); the keys bubble from the tab to the strip.
  tab("claude").element().focus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(tab("codex stopped")).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(tab("shell")).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(tab("codex stopped")).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{Home}");
  await expect.element(tab("shell")).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{End}");
  await expect.element(tab("codex stopped")).toHaveAttribute("aria-selected", "true");
});

/** Where the tab's leading glyph starts, measured from the tab's own left edge. */
function glyphOffset(name: string): number {
  const button = strip().getByRole("tab", { name }).element().getBoundingClientRect();
  const glyph = strip()
    .getByRole("tab", { name })
    .element()
    .querySelector("svg")!
    .getBoundingClientRect();
  return glyph.left - button.left;
}

test("a tab keeps its width when a session starts working", async () => {
  // The status glyph and the kind icon share one 20 px slot; without it the tab grew by ~6 px.
  const working = await renderTabs(
    [session("s1", "claude", { state: "working", updatedAt: 1 })],
    "s1",
  ).rendered;
  const workingWidth = tab("claude").element().getBoundingClientRect().width;
  const workingGlyph = glyphOffset("claude");
  await working.unmount();

  await renderTabs([session("s1", "claude")], "s1").rendered;
  const idleWidth = tab("claude").element().getBoundingClientRect().width;
  const idleGlyph = glyphOffset("claude");

  expect(workingWidth).toBeCloseTo(idleWidth, 0);
  // The glyph sits at the same offset too: the shared 20 px slot, not merely the svg's size.
  expect(workingGlyph).toBeCloseTo(idleGlyph, 0);
});

test("a running session stops and a stopped session restarts through their context menus", async () => {
  const { rendered, props } = renderTabs(undefined, "s1");
  await rendered;
  await tab("shell").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Stop shell" }).click();
  expect(props.onStop).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
  await tab("codex stopped").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Restart codex" }).click();
  expect(props.onRestart).toHaveBeenCalledWith(expect.objectContaining({ id: "s3" }));
});

test("a stopped shell and a failed start differ in glyph and name, and both offer Restart", async () => {
  const { rendered, props } = renderTabs(
    [
      session("s1", "shell", null, "stopped"),
      {
        ...session(
          "s2",
          "claude",
          { state: "error", updatedAt: 2, message: "claude did not answer" },
          "stopped",
        ),
        launchError: "claude did not answer within 15 s",
      },
    ],
    "s1",
  );
  await rendered;

  const stopped = strip().getByRole("tab", { name: "shell stopped" });
  const failed = strip().getByRole("tab", { name: "claude failed" });
  await expect.element(stopped).toBeVisible();
  await expect.element(failed).toBeVisible();
  // The stopped shell keeps its logo; the failed start takes the error glyph in the same slot.
  expect(stopped.element().querySelector("[data-status]")).toBeNull();
  expect(failed.element().querySelector('[data-status="error"]')).not.toBeNull();
  expect(stopped.element().getAttribute("title")).toContain("stopped");
  expect(stopped.element().getAttribute("title")).toContain("Restart");
  expect(failed.element().getAttribute("title")).toContain("failed");
  expect(failed.element().getAttribute("title")).toContain("Restart");

  await stopped.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Restart shell" }).click();
  expect(props.onRestart).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));

  await failed.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Restart claude" }).click();
  expect(props.onRestart).toHaveBeenLastCalledWith(expect.objectContaining({ id: "s2" }));
});

test("a status-only error is still a failed tab and its tooltip carries the reason", async () => {
  const { rendered } = renderTabs(
    [
      session(
        "s1",
        "claude",
        { state: "error", updatedAt: 1, message: "claude crashed" },
        "stopped",
      ),
    ],
    "s1",
  );
  await rendered;

  const failed = strip().getByRole("tab", { name: "claude failed" });
  await expect.element(failed).toBeVisible();
  expect(failed.element().querySelector('[data-status="error"]')).not.toBeNull();
  expect(failed.element().getAttribute("title")).toContain("claude crashed");
});

test("an unresumable session's menu offers a new conversation, not a restart", async () => {
  const { rendered, props } = renderTabs([session("s1", "codex", null, "unresumable")], "s1");
  await rendered;

  const unresumable = strip().getByRole("tab", { name: "codex unresumable" });
  await expect.element(unresumable).toBeVisible();
  expect(unresumable.element().querySelector("[data-status]")).toBeNull();
  expect(unresumable.element().getAttribute("title")).toContain("unresumable");
  expect(unresumable.element().getAttribute("title")).toContain("Start a new conversation");

  await unresumable.click({ button: "right" });
  await expect
    .element(page.getByRole("menuitem", { name: "Start a new conversation" }))
    .toBeVisible();
  expect(page.getByRole("menuitem", { name: /Restart/ }).elements()).toHaveLength(0);
  await page.getByRole("menuitem", { name: "Start a new conversation" }).click();
  expect(props.onRestart).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
});

test("the keyboard context menu renames with the tab as opener and asks before removal", async () => {
  const { rendered, props } = renderTabs(undefined, "s3");
  await rendered;
  tab("codex stopped").element().focus();
  await userEvent.keyboard("{Shift>}{F10}{/Shift}");
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  expect(props.onRename).toHaveBeenCalledWith(
    expect.objectContaining({ id: "s3" }),
    tab("codex stopped").element(),
  );
  await tab("codex stopped").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove session…" }).click();
  expect(props.onRemove).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "s3" }));
});

test("short adjacent tabs have no invisible action gutter, and hover does not grow them", async () => {
  await renderTabs(undefined, "s1").rendered;
  const first = tab("shell").element().getBoundingClientRect(),
    second = tab("claude").element().getBoundingClientRect();
  expect(second.left - first.right).toBeLessThanOrEqual(4);
  await tab("shell").hover();
  expect(tab("shell").element().getBoundingClientRect().width).toBe(first.width);
  expect(strip().getByRole("button").elements()).toHaveLength(1);
});

test("a clipped session label exposes its full name on keyboard focus", async () => {
  const name = "A deliberately long session label that does not fit a compact tab";
  await renderTabs([{ ...session("s1", "pi"), label: name }], "s1").rendered;
  tab(name).element().focus();
  await expect.element(page.getByRole("tooltip")).toMatchTextContent(name);
});

test("the trailing + offers a shell and an agent", async () => {
  const { rendered, props } = renderTabs();
  await rendered;

  await strip().getByRole("button", { name: "Add session" }).click();
  await page.getByRole("menuitem", { name: "Shell" }).click();
  expect(props.onNewShell).toHaveBeenCalledOnce();

  await strip().getByRole("button", { name: "Add session" }).click();
  await page.getByRole("menuitem", { name: "Agent…" }).click();
  expect(props.onNewAgent).toHaveBeenCalledOnce();
});

test("Enter on the selected tab that is not running starts it again", async () => {
  const { rendered, props } = renderTabs(undefined, "s3");
  await rendered;

  strip().getByRole("tab", { name: "codex stopped" }).element().focus();
  await userEvent.keyboard("{Enter}");
  expect(props.onRestart).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "s3" }));
});
