import type { Session, Task } from "@corral/protocol/rpc";
import { recordOf } from "./json-record.ts";

/** A device-local layout; the server owns the sessions, not their presentation. */
export type TaskTabKind = "session" | "file" | "terminal";
export type TaskTabGroup = "main" | "companion";

/** The narrowest a group gets; a strip with one tab still fits, and the split stays free. */
export const COMPANION_MIN_WIDTH = 160;
export const COMPANION_DEFAULT_WIDTH = 600;
export const COMPANION_MAX_WIDTH = 900;

export interface TaskTab {
  kind: TaskTabKind;
  /** `session` only. */
  sessionId?: string;
  /** `file` only. */
  path?: string;
  /** `terminal` only: a terminal outside any session, such as the one `files.openEditor` starts. */
  terminalId?: string;
  group: TaskTabGroup;
}

export interface TaskTabLayout {
  tabs: readonly TaskTab[];
  /** The selected tab of each group, including a temporarily hidden group. */
  active: { main?: string; companion?: string };
  focused: TaskTabGroup;
  expanded: TaskTabGroup | null;
  companionWidth: number;
  /**
   * Every session this layout has ever shown. A session missing from `tabs` was closed; a session
   * missing here arrived from the server (a restore, or another view) and joins the main group.
   */
  seenSessions: readonly string[];
}

export const TASK_TAB_STORAGE_PREFIX = "corral.task-tabs.";

export function tabId(tab: TaskTab): string {
  if (tab.kind === "session") return `session:${tab.sessionId ?? ""}`;
  if (tab.kind === "terminal") return `terminal:${tab.terminalId ?? ""}`;
  return `file:${tab.path ?? ""}`;
}

export function tabsInGroup(
  layout: Pick<TaskTabLayout, "tabs">,
  group: TaskTabGroup,
): readonly TaskTab[] {
  return layout.tabs.filter((tab) => tab.group === group);
}

export function activeTab(
  layout: Pick<TaskTabLayout, "tabs" | "active">,
  group: TaskTabGroup,
): TaskTab | undefined {
  const id = layout.active[group];
  if (id === undefined) return undefined;
  return layout.tabs.find((tab) => tab.group === group && tabId(tab) === id);
}

export function taskSessions(task: Pick<Task, "id">, sessions: readonly Session[]): Session[] {
  return sessions
    .filter((session) => session.taskId === task.id)
    .toSorted((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The server's creation order, with the primary session pulled to the front. */
export function orderedTaskSessions(
  task: Pick<Task, "id" | "primarySessionId">,
  sessions: readonly Session[],
): Session[] {
  const ofTask = taskSessions(task, sessions);
  const primary = ofTask.find((session) => session.id === task.primarySessionId);
  return primary === undefined
    ? ofTask
    : [primary, ...ofTask.filter((session) => session.id !== primary.id)];
}

export function defaultLayout(
  task: Pick<Task, "id" | "primarySessionId">,
  sessions: readonly Session[],
  companionWidth = COMPANION_DEFAULT_WIDTH,
): TaskTabLayout {
  const ordered = orderedTaskSessions(task, sessions);
  const tabs = ordered.map<TaskTab>((session) => ({
    kind: "session",
    sessionId: session.id,
    group: "main",
  }));
  const first = tabs[0];
  return {
    tabs,
    active: first === undefined ? {} : { main: tabId(first) },
    focused: "main",
    expanded: null,
    companionWidth,
    seenSessions: ordered.map((session) => session.id),
  };
}

function uniqueTabs(tabs: readonly TaskTab[]): TaskTab[] {
  const seen = new Set<string>();
  return tabs.filter((tab) => {
    const id = tabId(tab);
    if ((tab.kind === "session" && tab.sessionId === undefined) || seen.has(id)) return false;
    if (tab.kind === "file" && (tab.path === undefined || tab.path === "")) return false;
    if (tab.kind === "terminal" && (tab.terminalId === undefined || tab.terminalId === ""))
      return false;
    seen.add(id);
    return true;
  });
}

function hasSession(sessions: ReadonlySet<string>, tab: TaskTab): boolean {
  return tab.kind !== "session" || (tab.sessionId !== undefined && sessions.has(tab.sessionId));
}

/** The active id a group falls back to after its current tab leaves. */
function fallbackActive(
  before: readonly TaskTab[],
  after: readonly TaskTab[],
  group: TaskTabGroup,
  preferred: string | undefined,
): string | undefined {
  const inGroup = tabsInGroup({ tabs: after }, group);
  if (inGroup.length === 0) return undefined;
  if (preferred !== undefined && inGroup.some((tab) => tabId(tab) === preferred)) return preferred;
  const removed = tabsInGroup({ tabs: before }, group).find((tab) => tabId(tab) === preferred);
  return removed === undefined
    ? tabId(inGroup[0]!)
    : nextActiveAfterRemoval(before, after, group, removed);
}

function sameLayout(a: TaskTabLayout, b: TaskTabLayout): boolean {
  return (
    a.focused === b.focused &&
    a.expanded === b.expanded &&
    a.companionWidth === b.companionWidth &&
    a.active.main === b.active.main &&
    a.active.companion === b.active.companion &&
    a.tabs.length === b.tabs.length &&
    a.seenSessions.length === b.seenSessions.length &&
    a.tabs.every(
      (tab, index) => tabId(tab) === tabId(b.tabs[index]!) && tab.group === b.tabs[index]!.group,
    ) &&
    a.seenSessions.every((id, index) => id === b.seenSessions[index])
  );
}

/**
 * Fits a stored layout to the sessions the server has now: a removed session loses its tab, and a
 * session this layout has never shown joins the main group at the end. A session the layout showed
 * and that was closed stays out, even though the server still lists it as stopped.
 */
export function reconcileLayout(
  stored: TaskTabLayout | undefined,
  task: Pick<Task, "id" | "primarySessionId">,
  sessions: readonly Session[],
  defaultWidth = COMPANION_DEFAULT_WIDTH,
): TaskTabLayout {
  if (stored === undefined) return defaultLayout(task, sessions, defaultWidth);
  const available = new Set(taskSessions(task, sessions).map((session) => session.id));
  const known = new Set(stored.seenSessions.filter((id) => available.has(id)));
  const tabs = uniqueTabs(stored.tabs.filter((tab) => hasSession(available, tab))).map((tab) => {
    if (tab.kind === "session" && tab.sessionId !== undefined) known.add(tab.sessionId);
    return tab;
  });
  for (const session of orderedTaskSessions(task, sessions)) {
    if (known.has(session.id)) continue;
    known.add(session.id);
    tabs.push({ kind: "session", sessionId: session.id, group: "main" });
  }
  const main = fallbackActive(stored.tabs, tabs, "main", stored.active.main);
  const companion = fallbackActive(stored.tabs, tabs, "companion", stored.active.companion);
  const next: TaskTabLayout = {
    ...stored,
    tabs,
    active: {
      ...(main === undefined ? {} : { main }),
      ...(companion === undefined ? {} : { companion }),
    },
    seenSessions: [...known],
  };
  const normalized = normalizeGroups(next);
  return sameLayout(stored, normalized) ? stored : normalized;
}

function normalizeGroups(layout: TaskTabLayout): TaskTabLayout {
  const hasMain = layout.tabs.some((tab) => tab.group === "main");
  const hasCompanion = layout.tabs.some((tab) => tab.group === "companion");
  const focused =
    layout.focused === "main"
      ? hasMain || !hasCompanion
        ? "main"
        : "companion"
      : hasCompanion
        ? "companion"
        : "main";
  const expanded = hasMain && hasCompanion ? layout.expanded : null;
  return focused === layout.focused && expanded === layout.expanded
    ? layout
    : { ...layout, focused, expanded };
}

export function selectTab(layout: TaskTabLayout, id: string): TaskTabLayout {
  const tab = layout.tabs.find((candidate) => tabId(candidate) === id);
  if (tab === undefined) return layout;
  if (layout.active[tab.group] === id && layout.focused === tab.group) return layout;
  return {
    ...layout,
    active: { ...layout.active, [tab.group]: id },
    focused: tab.group,
    expanded: layout.expanded === null ? null : tab.group,
  };
}

export function addTab(layout: TaskTabLayout, tab: TaskTab): TaskTabLayout {
  const id = tabId(tab);
  const existing = layout.tabs.find((candidate) => tabId(candidate) === id);
  if (existing !== undefined) {
    return existing.group === tab.group ? selectTab(layout, id) : moveTab(layout, id, tab.group);
  }
  const tabs = [...layout.tabs, tab];
  const seenSessions =
    tab.kind === "session" && tab.sessionId !== undefined
      ? layout.seenSessions.includes(tab.sessionId)
        ? layout.seenSessions
        : [...layout.seenSessions, tab.sessionId]
      : layout.seenSessions;
  const active = { ...layout.active, [tab.group]: id };
  return {
    ...layout,
    tabs,
    active,
    focused: tab.group,
    expanded: layout.expanded === null ? null : tab.group,
    seenSessions,
  };
}

/** Next right, else left, else the group's first remaining tab, as both references do. */
function nextActiveAfterRemoval(
  before: readonly TaskTab[],
  after: readonly TaskTab[],
  group: TaskTabGroup,
  removed: TaskTab,
): string | undefined {
  const inGroup = tabsInGroup({ tabs: before }, group);
  const remaining = tabsInGroup({ tabs: after }, group);
  if (remaining.length === 0) return undefined;
  const removedId = tabId(removed);
  const index = inGroup.findIndex((tab) => tabId(tab) === removedId);
  if (index === -1) return tabId(remaining[0]!);
  const right = inGroup[index + 1];
  if (right !== undefined && remaining.some((tab) => tabId(tab) === tabId(right)))
    return tabId(right);
  const left = inGroup[index - 1];
  if (left !== undefined && remaining.some((tab) => tabId(tab) === tabId(left))) return tabId(left);
  return tabId(remaining[0]!);
}

/**
 * Closing a view. The primary session is not a closable view: removing it is the destructive
 * `Remove session…` path. Any other session is stopped by the workspace before this call, so a
 * closed tab never leaves a running process without a view.
 */
export function closeTab(
  layout: TaskTabLayout,
  id: string,
  primarySessionId: string | null,
): TaskTabLayout {
  const tab = layout.tabs.find((candidate) => tabId(candidate) === id);
  if (tab === undefined) return layout;
  if (tab.kind === "session" && tab.sessionId === primarySessionId) return layout;
  const tabs = layout.tabs.filter((candidate) => tabId(candidate) !== id);
  const active = { ...layout.active };
  if (layout.active[tab.group] === id) {
    const next = nextActiveAfterRemoval(layout.tabs, tabs, tab.group, tab);
    if (next === undefined) delete active[tab.group];
    else active[tab.group] = next;
  }
  return normalizeGroups({
    ...layout,
    tabs,
    active,
  });
}

/** Drops a session that the server really removed, from the strip and `seen`. */
export function removeSession(layout: TaskTabLayout, sessionId: string): TaskTabLayout {
  const matches = (tab: TaskTab) => tab.kind === "session" && tab.sessionId === sessionId;
  const removed = layout.tabs.find(matches);
  const tabs = layout.tabs.filter((tab) => !matches(tab));
  if (removed === undefined && !layout.seenSessions.includes(sessionId)) return layout;
  const active = { ...layout.active };
  if (removed !== undefined && layout.active[removed.group] === tabId(removed)) {
    const next = nextActiveAfterRemoval(layout.tabs, tabs, removed.group, removed);
    if (next === undefined) delete active[removed.group];
    else active[removed.group] = next;
  }
  return normalizeGroups({
    ...layout,
    tabs,
    active,
    seenSessions: layout.seenSessions.filter((id) => id !== sessionId),
  });
}

/** Move to an index in the destination after removing the tab from its old position. */
export function moveTab(
  layout: TaskTabLayout,
  id: string,
  target: TaskTabGroup,
  index?: number,
): TaskTabLayout {
  const tab = layout.tabs.find((candidate) => tabId(candidate) === id);
  if (tab === undefined) return layout;
  const remaining = layout.tabs.filter((candidate) => tabId(candidate) !== id);
  const targetTabs = tabsInGroup({ tabs: remaining }, target);
  const at = Math.max(0, Math.min(index ?? targetTabs.length, targetTabs.length));
  const inTarget = [...targetTabs];
  inTarget.splice(at, 0, { ...tab, group: target });
  const other: TaskTabGroup = target === "main" ? "companion" : "main";
  const otherTabs = tabsInGroup({ tabs: remaining }, other);
  const tabs = target === "main" ? [...inTarget, ...otherTabs] : [...otherTabs, ...inTarget];
  const active = { ...layout.active };
  if (tab.group !== target && layout.active[tab.group] === id) {
    const next = nextActiveAfterRemoval(layout.tabs, tabs, tab.group, tab);
    if (next === undefined) delete active[tab.group];
    else active[tab.group] = next;
  }
  active[target] = id;
  const next = normalizeGroups({
    ...layout,
    tabs,
    active,
    focused: target,
    expanded: layout.expanded === null ? null : target,
  });
  return sameLayout(layout, next) ? layout : next;
}

export function focusGroup(layout: TaskTabLayout, group: TaskTabGroup): TaskTabLayout {
  if (tabsInGroup(layout, group).length === 0) return layout;
  const expanded = layout.expanded === null ? null : group;
  if (layout.focused === group && layout.expanded === expanded) return layout;
  return { ...layout, focused: group, expanded };
}

export function toggleExpanded(layout: TaskTabLayout, group: TaskTabGroup): TaskTabLayout {
  if (tabsInGroup(layout, "main").length === 0 || tabsInGroup(layout, "companion").length === 0)
    return layout;
  return {
    ...layout,
    focused: group,
    expanded: layout.expanded === group ? null : group,
  };
}

/** Session tabs carry 1–9 within their own group; file and terminal tabs carry no number. */
export function tabNumber(layout: Pick<TaskTabLayout, "tabs">, id: string): number | undefined {
  const tab = layout.tabs.find((candidate) => tabId(candidate) === id);
  if (tab === undefined || tab.kind !== "session") return undefined;
  let number = 0;
  for (const candidate of tabsInGroup(layout, tab.group)) {
    if (candidate.kind !== "session") continue;
    number += 1;
    if (tabId(candidate) === id) return number <= 9 ? number : undefined;
  }
  return undefined;
}

/** The n-th session tab of a group, as the prefix number keys name it. */
export function sessionTabAt(
  layout: Pick<TaskTabLayout, "tabs">,
  group: TaskTabGroup,
  number: number,
): TaskTab | undefined {
  let seen = 0;
  for (const tab of tabsInGroup(layout, group)) {
    if (tab.kind !== "session") continue;
    seen += 1;
    if (seen === number) return tab;
  }
  return undefined;
}

/** One step within a group, wrapping; file tabs are steps too. */
export function stepTab(
  layout: Pick<TaskTabLayout, "tabs" | "active">,
  group: TaskTabGroup,
  step: 1 | -1,
): TaskTab | undefined {
  const inGroup = tabsInGroup(layout, group);
  if (inGroup.length < 2) return undefined;
  const current = layout.active[group];
  const index = inGroup.findIndex((tab) => tabId(tab) === current);
  const next = inGroup[(index < 0 ? 0 : index + step + inGroup.length) % inGroup.length];
  return next === undefined || tabId(next) === current ? undefined : next;
}

interface StoredTab {
  kind: TaskTabKind;
  sessionId?: string;
  path?: string;
  terminalId?: string;
  group: TaskTabGroup;
  order: number;
}

interface StoredLayout {
  version: 2;
  tabs: StoredTab[];
  active: { main?: string; companion?: string };
  focused: TaskTabGroup;
  expanded: TaskTabGroup | null;
  companionWidth: number;
  seenSessions: string[];
}

function storedTab(tab: TaskTab, order: number): StoredTab {
  return {
    kind: tab.kind,
    ...(tab.sessionId === undefined ? {} : { sessionId: tab.sessionId }),
    ...(tab.path === undefined ? {} : { path: tab.path }),
    ...(tab.terminalId === undefined ? {} : { terminalId: tab.terminalId }),
    group: tab.group,
    order,
  };
}

/** The device-local record: tab identity, group and order, plus the active tab of each group. */
export function serializeLayout(layout: TaskTabLayout): string {
  const tabs: StoredTab[] = [];
  for (const group of ["main", "companion"] as const) {
    tabsInGroup(layout, group).forEach((tab, order) => tabs.push(storedTab(tab, order)));
  }
  const stored: StoredLayout = {
    version: 2,
    tabs,
    active: {
      ...(layout.active.main === undefined ? {} : { main: layout.active.main }),
      ...(layout.active.companion === undefined ? {} : { companion: layout.active.companion }),
    },
    focused: layout.focused,
    expanded: layout.expanded,
    companionWidth: layout.companionWidth,
    seenSessions: [...layout.seenSessions],
  };
  return JSON.stringify(stored);
}

function asGroup(value: unknown): TaskTabGroup | undefined {
  return value === "main" || value === "companion" ? value : undefined;
}

function asKind(value: unknown): TaskTabKind | undefined {
  return value === "session" || value === "file" || value === "terminal" ? value : undefined;
}

interface ReadTab {
  tab: TaskTab;
  order: number;
}

function readStoredTab(value: unknown): ReadTab | undefined {
  const record = recordOf(value);
  if (record === undefined) return undefined;
  const kind = asKind(record["kind"]);
  const group = asGroup(record["group"]);
  const order = record["order"];
  if (
    kind === undefined ||
    group === undefined ||
    typeof order !== "number" ||
    !Number.isFinite(order)
  )
    return undefined;
  const sessionId = record["sessionId"];
  const path = record["path"];
  const terminalId = record["terminalId"];
  if (kind === "session" && (typeof sessionId !== "string" || sessionId === "")) return undefined;
  if (kind === "file" && (typeof path !== "string" || path === "")) return undefined;
  if (kind === "terminal" && (typeof terminalId !== "string" || terminalId === ""))
    return undefined;
  return {
    tab: {
      kind,
      group,
      ...(typeof sessionId === "string" ? { sessionId } : {}),
      ...(typeof path === "string" ? { path } : {}),
      ...(typeof terminalId === "string" ? { terminalId } : {}),
    },
    order: Math.max(0, Math.round(order)),
  };
}

/**
 * A stored record, or `undefined` when it is absent, another version or malformed. A record from
 * before the closed-tab history was removed still carries `closed`, and one from before the
 * Changes tab was removed still carries a `changes` tab; both are read without them. Version 1's
 * companion visibility and shared width are imported into the per-task layout.
 */
export function parseLayout(
  raw: string | null,
  legacyWidth = COMPANION_DEFAULT_WIDTH,
): TaskTabLayout | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const record = recordOf(parsed);
  if (record === undefined) return undefined;
  if ((record["version"] !== 1 && record["version"] !== 2) || !Array.isArray(record["tabs"]))
    return undefined;
  const tabs = record["tabs"].flatMap((value) => {
    const entry = readStoredTab(value);
    return entry === undefined ? [] : [entry];
  });
  tabs.sort((a, b) => {
    if (a.tab.group !== b.tab.group) return a.tab.group === "main" ? -1 : 1;
    return a.order - b.order;
  });
  const active = recordOf(record["active"]);
  const activeMain = active?.["main"];
  const activeCompanion = active?.["companion"];
  const seenSessions = Array.isArray(record["seenSessions"])
    ? record["seenSessions"].filter((id): id is string => typeof id === "string")
    : [];
  const ordered = tabs.map((entry) => entry.tab);
  const namesTab = (group: TaskTabGroup, id: string) =>
    ordered.some((tab) => tab.group === group && tabId(tab) === id);
  const main =
    typeof activeMain === "string" && namesTab("main", activeMain) ? activeMain : undefined;
  const companion =
    typeof activeCompanion === "string" && namesTab("companion", activeCompanion)
      ? activeCompanion
      : undefined;
  const width = record["companionWidth"];
  const focused = asGroup(record["focused"]) ?? "main";
  const expanded =
    record["version"] === 1
      ? record["companionOpen"] === true
        ? null
        : "main"
      : (asGroup(record["expanded"]) ?? null);
  return normalizeGroups({
    tabs: ordered,
    active: {
      ...(main === undefined ? {} : { main }),
      ...(companion === undefined ? {} : { companion }),
    },
    focused,
    expanded,
    companionWidth:
      typeof width === "number" && Number.isFinite(width)
        ? Math.round(Math.max(COMPANION_MIN_WIDTH, Math.min(COMPANION_MAX_WIDTH, width)))
        : legacyWidth,
    seenSessions,
  });
}
