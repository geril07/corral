import { sessionLabels } from "@corral/client/session-labels";
import type { SessionEntry } from "@corral/client/workspace-tree";
import { DEFAULT_BINDINGS, DEFAULT_PREFIX, type ClientConfig } from "@corral/protocol/config";
import type { AgentStatus, Session } from "@corral/protocol/rpc";
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
  const rendered = render(<SessionTabs {...props} />);
  return { rendered, props };
}

const strip = () => page.getByRole("tablist", { name: "Sessions" });
const tab = (name: string) => strip().getByRole("tab", { name });

test("one tab per session, in creation order, numbered for the first nine", async () => {
  await renderTabs(
    Array.from({ length: 10 }, (_, index) => session(`s${index + 1}`, "shell")),
    "s1",
  ).rendered;

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
});

test("the selected tab is marked and pressing another one reports it", async () => {
  const { rendered, props } = renderTabs(undefined, "s2");
  await rendered;

  await expect.element(tab("claude")).toHaveAttribute("aria-selected", "true");
  await expect.element(tab("shell")).toHaveAttribute("aria-selected", "false");

  await tab("shell").click();
  expect(props.onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));
});

test("arrow keys and Home/End move the selection along the strip", async () => {
  const { rendered, props } = renderTabs(undefined, "s2");
  await rendered;

  tab("claude").element().focus();
  await userEvent.keyboard("{ArrowRight}");
  expect(props.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: "s3" }));
  await userEvent.keyboard("{Home}");
  expect(props.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: "s1" }));
  await userEvent.keyboard("{End}");
  expect(props.onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: "s3" }));
});

test("a running tab stops its session and a stopped one restarts it", async () => {
  const { rendered, props } = renderTabs(undefined, "s1");
  await rendered;

  await strip().getByRole("button", { name: "stop shell" }).click();
  expect(props.onStop).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }));

  await strip().getByRole("button", { name: "restart codex" }).click();
  expect(props.onRestart).toHaveBeenCalledWith(expect.objectContaining({ id: "s3" }));
});

test("a stopped session names its state and its menu and close ask before removing it", async () => {
  const { rendered, props } = renderTabs(undefined, "s3");
  await rendered;

  await expect.element(strip().getByRole("button", { name: "restart codex" })).toBeVisible();
  await strip().getByRole("button", { name: "Session actions for codex" }).click();
  await page.getByRole("menuitem", { name: "Remove session…" }).click();
  expect(props.onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: "s3" }));

  await strip().getByRole("button", { name: "Close codex" }).click();
  expect(props.onRemove).toHaveBeenCalledTimes(2);

  await strip().getByRole("button", { name: "Session actions for codex" }).click();
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  expect(props.onRename).toHaveBeenCalledWith(
    expect.objectContaining({ id: "s3" }),
    expect.any(HTMLButtonElement),
  );
});

test("a tab's close, menu and stop appear on hover; the selected tab keeps them", async () => {
  const { rendered } = renderTabs(undefined, "s1");
  await rendered;

  const actions = () => strip().getByRole("tab", { name: "claude" }).element().nextElementSibling;
  const selected = strip().getByRole("tab", { name: "shell" }).element().nextElementSibling;
  expect(getComputedStyle(selected!).opacity).toBe("1");
  expect(getComputedStyle(actions()!).opacity).toBe("0");

  await tab("claude").hover();
  await expect.poll(() => getComputedStyle(actions()!).opacity).toBe("1");
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
