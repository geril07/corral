import type { Session, Task } from "@corral/protocol/rpc";
import { recordOf } from "./json-record.ts";

/**
 * A task's working area is one layout with two groups (`docs/layout.md`, **Working area**). The
 * main group is always visible; the companion group is hidden until it has a tab and the user
 * opens it. A tab is a view of something that outlives it: closing one never removes the session
 * behind it. The layout is device-local and stored per task; the server owns none of it.
 */
export type TaskTabKind = "session" | "changes" | "file";
export type TaskTabGroup = "main" | "companion";

export interface TaskTab {
  kind: TaskTabKind;
  /** `session` only. */
  sessionId?: string;
  /** `file` only. */
  path?: string;
  group: TaskTabGroup;
}

/** A closed view waits here; reopening puts it back in its group at its old order. */
export interface ClosedTaskTab {
  tab: TaskTab;
  order: number;
}

export interface TaskTabLayout {
  tabs: readonly TaskTab[];
  /** The current tab id in each visible group. */
  active: { main?: string; companion?: string };
  /** The companion group keeps this preference while it is shut. */
  companionOpen: boolean;
  /** Most recent last; every closed view stays reopenable for the life of the task. */
  closed: readonly ClosedTaskTab[];
  /**
   * Every session this layout has ever shown. A session missing from `tabs` was closed as a view;
   * a session missing here arrived from the server (a restore, or another view) and joins the
   * main group.
   */
  seenSessions: readonly string[];
}

export const TASK_TAB_STORAGE_PREFIX = "corral.task-tabs.";

export function tabId(tab: TaskTab): string {
  if (tab.kind === "session") return `session:${tab.sessionId ?? ""}`;
  if (tab.kind === "file") return `file:${tab.path ?? ""}`;
  return "changes";
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
    companionOpen: false,
    closed: [],
    seenSessions: ordered.map((session) => session.id),
  };
}

function uniqueTabs(tabs: readonly TaskTab[]): TaskTab[] {
  const seen = new Set<string>();
  return tabs.filter((tab) => {
    const id = tabId(tab);
    if ((tab.kind === "session" && tab.sessionId === undefined) || seen.has(id)) return false;
    if (tab.kind === "file" && (tab.path === undefined || tab.path === "")) return false;
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
    a.companionOpen === b.companionOpen &&
    a.active.main === b.active.main &&
    a.active.companion === b.active.companion &&
    a.tabs.length === b.tabs.length &&
    a.closed.length === b.closed.length &&
    a.seenSessions.length === b.seenSessions.length &&
    a.tabs.every((tab, index) => tabId(tab) === tabId(b.tabs[index]!)) &&
    a.closed.every(
      (entry, index) =>
        tabId(entry.tab) === tabId(b.closed[index]!.tab) && entry.order === b.closed[index]!.order,
    ) &&
    a.seenSessions.every((id, index) => id === b.seenSessions[index])
  );
}

/**
 * Fits a stored layout to the sessions the server has now: a removed session loses its tab and
 * its closed entry, and a session this layout has never shown joins the main group at the end.
 * A closed tab is not a new session, so it stays closed after a reload.
 */
export function reconcileLayout(
  stored: TaskTabLayout | undefined,
  task: Pick<Task, "id" | "primarySessionId">,
  sessions: readonly Session[],
): TaskTabLayout {
  if (stored === undefined) return defaultLayout(task, sessions);
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
  // The primary role is not a position users can set: a stored layout that put it in the
  // companion group, or after another main tab, is normalised back to the first main tab.
  const primaryTab = tabs.find(
    (tab) => tab.kind === "session" && tab.sessionId === task.primarySessionId,
  );
  const orderedTabs =
    primaryTab === undefined
      ? tabs
      : [{ ...primaryTab, group: "main" as const }, ...tabs.filter((tab) => tab !== primaryTab)];
  const closed = stored.closed.filter((entry) => hasSession(available, entry.tab));
  const companionOpen =
    stored.companionOpen && orderedTabs.some((tab) => tab.group === "companion");
  const main = fallbackActive(stored.tabs, orderedTabs, "main", stored.active.main);
  const companion =
    tabsInGroup({ tabs: orderedTabs }, "companion").length === 0
      ? undefined
      : fallbackActive(stored.tabs, orderedTabs, "companion", stored.active.companion);
  const next: TaskTabLayout = {
    tabs: orderedTabs,
    active: {
      ...(main === undefined ? {} : { main }),
      ...(companion === undefined ? {} : { companion }),
    },
    companionOpen,
    closed,
    seenSessions: [...known],
  };
  return sameLayout(stored, next) ? stored : next;
}

export function selectTab(layout: TaskTabLayout, id: string): TaskTabLayout {
  const tab = layout.tabs.find((candidate) => tabId(candidate) === id);
  if (tab === undefined) return layout;
  const active = { ...layout.active, [tab.group]: id };
  if (tab.group === "main" && layout.active.main === id) return layout;
  if (tab.group === "companion" && layout.active.companion === id && layout.companionOpen)
    return layout;
  return {
    ...layout,
    active,
    companionOpen: tab.group === "companion" ? true : layout.companionOpen,
  };
}

export function addTab(layout: TaskTabLayout, tab: TaskTab): TaskTabLayout {
  const id = tabId(tab);
  if (layout.tabs.some((candidate) => tabId(candidate) === id)) {
    return selectTab(layout, id);
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
    companionOpen: tab.group === "companion" ? true : layout.companionOpen,
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
 * `Remove session…` path. An auxiliary session stays on the server and only leaves the strip.
 */
export function closeTab(
  layout: TaskTabLayout,
  id: string,
  primarySessionId: string | null,
): TaskTabLayout {
  const tab = layout.tabs.find((candidate) => tabId(candidate) === id);
  if (tab === undefined) return layout;
  if (tab.kind === "session" && tab.sessionId === primarySessionId) return layout;
  const groupTabs = tabsInGroup(layout, tab.group);
  const order = groupTabs.findIndex((candidate) => tabId(candidate) === id);
  const tabs = layout.tabs.filter((candidate) => tabId(candidate) !== id);
  const active = { ...layout.active };
  if (layout.active[tab.group] === id) {
    const next = nextActiveAfterRemoval(layout.tabs, tabs, tab.group, tab);
    if (next === undefined) delete active[tab.group];
    else active[tab.group] = next;
  }
  const closed = [...layout.closed, { tab, order: Math.max(0, order) }];
  return {
    ...layout,
    tabs,
    active,
    closed,
    companionOpen:
      tab.group === "companion" && tabsInGroup({ tabs }, "companion").length === 0
        ? false
        : layout.companionOpen,
  };
}

/**
 * Puts the most recently closed view back where it came from. A session removed in the meantime
 * is not resurrected; the stack entry is dropped instead.
 */
export function reopenLast(
  layout: TaskTabLayout,
  task: Pick<Task, "id" | "primarySessionId">,
  sessions: readonly Session[],
): TaskTabLayout {
  if (layout.closed.length === 0) return layout;
  const available = new Set(taskSessions(task, sessions).map((session) => session.id));
  const stack = [...layout.closed];
  let entry: ClosedTaskTab | undefined;
  while (stack.length > 0) {
    const candidate = stack.pop()!;
    if (
      candidate.tab.kind !== "session" ||
      (candidate.tab.sessionId !== undefined && available.has(candidate.tab.sessionId))
    ) {
      entry = candidate;
      break;
    }
  }
  if (entry === undefined) return { ...layout, closed: [] };
  const id = tabId(entry.tab);
  if (layout.tabs.some((tab) => tabId(tab) === id)) return { ...layout, closed: stack };
  const groupTabs = tabsInGroup(layout, entry.tab.group);
  const before = groupTabs.slice(0, Math.min(entry.order, groupTabs.length));
  const after = groupTabs.slice(before.length);
  const reopened = entry.tab;
  const tabs = [
    ...layout.tabs.filter((tab) => tab.group !== reopened.group),
    ...before,
    reopened,
    ...after,
  ];
  return {
    ...layout,
    tabs,
    closed: stack,
    active: { ...layout.active, [reopened.group]: id },
    companionOpen: reopened.group === "companion" ? true : layout.companionOpen,
  };
}

/** Drops a session that the server really removed, from the strip, the closed stack and `seen`. */
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
  return {
    ...layout,
    tabs,
    active,
    closed: layout.closed.filter((entry) => !matches(entry.tab)),
    seenSessions: layout.seenSessions.filter((id) => id !== sessionId),
    companionOpen: tabsInGroup({ tabs }, "companion").length === 0 ? false : layout.companionOpen,
  };
}

/**
 * The keyboard's move-to-the-other-group. Moving the last main tab is refused, so this command
 * never leaves the main group empty; Changes belongs to the companion group and does not move.
 */
export function moveTab(
  layout: TaskTabLayout,
  id: string,
  primarySessionId: string | null,
): TaskTabLayout {
  const tab = layout.tabs.find((candidate) => tabId(candidate) === id);
  if (tab === undefined || tab.kind === "changes") return layout;
  if (tab.kind === "session" && tab.sessionId === primarySessionId) return layout;
  if (tab.group === "main" && tabsInGroup(layout, "main").length === 1) return layout;
  const target: TaskTabGroup = tab.group === "main" ? "companion" : "main";
  const moved: TaskTab = { ...tab, group: target };
  const tabs = [...layout.tabs.filter((candidate) => tabId(candidate) !== id), moved];
  const active = { ...layout.active };
  if (layout.active[tab.group] === id) {
    const next = nextActiveAfterRemoval(layout.tabs, tabs, tab.group, tab);
    if (next === undefined) delete active[tab.group];
    else active[tab.group] = next;
  }
  active[target] = id;
  const companionRemains = tabsInGroup({ tabs }, "companion").length > 0;
  return {
    ...layout,
    tabs,
    active,
    companionOpen: target === "companion" ? true : companionRemains ? layout.companionOpen : false,
  };
}

/** Toggling an empty companion group opens Changes, so the group is never an empty half. */
export function toggleCompanion(layout: TaskTabLayout): TaskTabLayout {
  if (layout.companionOpen) {
    return { ...layout, companionOpen: false };
  }
  if (tabsInGroup(layout, "companion").length > 0) {
    return { ...layout, companionOpen: true };
  }
  const changes: TaskTab = { kind: "changes", group: "companion" };
  const opened = addTab(layout, changes);
  return { ...opened, companionOpen: true };
}

/** Session tabs carry 1–9 within their own group; Changes and files carry no number. */
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

/** One step within a group, wrapping; Changes and file tabs are steps too. */
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
  group: TaskTabGroup;
  order: number;
}

interface StoredLayout {
  version: 1;
  tabs: StoredTab[];
  active: { main?: string; companion?: string };
  companionOpen: boolean;
  closed: StoredTab[];
  seenSessions: string[];
}

function storedTab(tab: TaskTab, order: number): StoredTab {
  return {
    kind: tab.kind,
    ...(tab.sessionId === undefined ? {} : { sessionId: tab.sessionId }),
    ...(tab.path === undefined ? {} : { path: tab.path }),
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
  const closed: StoredTab[] = layout.closed.map((entry) => ({
    ...storedTab(entry.tab, entry.order),
  }));
  const stored: StoredLayout = {
    version: 1,
    tabs,
    active: {
      ...(layout.active.main === undefined ? {} : { main: layout.active.main }),
      ...(layout.active.companion === undefined ? {} : { companion: layout.active.companion }),
    },
    companionOpen: layout.companionOpen,
    closed,
    seenSessions: [...layout.seenSessions],
  };
  return JSON.stringify(stored);
}

function asGroup(value: unknown): TaskTabGroup | undefined {
  return value === "main" || value === "companion" ? value : undefined;
}

function asKind(value: unknown): TaskTabKind | undefined {
  return value === "session" || value === "changes" || value === "file" ? value : undefined;
}

function readStoredTab(value: unknown): ClosedTaskTab | undefined {
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
  if (kind === "session" && (typeof sessionId !== "string" || sessionId === "")) return undefined;
  if (kind === "file" && (typeof path !== "string" || path === "")) return undefined;
  return {
    tab: {
      kind,
      group,
      ...(typeof sessionId === "string" ? { sessionId } : {}),
      ...(typeof path === "string" ? { path } : {}),
    },
    order: Math.max(0, Math.round(order)),
  };
}

/** A stored record, or `undefined` when it is absent, another version or malformed. */
export function parseLayout(raw: string | null): TaskTabLayout | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const record = recordOf(parsed);
  if (record === undefined) return undefined;
  if (record["version"] !== 1 || !Array.isArray(record["tabs"])) return undefined;
  const tabs = record["tabs"].flatMap((value) => {
    const entry = readStoredTab(value);
    return entry === undefined ? [] : [entry];
  });
  tabs.sort((a, b) => {
    if (a.tab.group !== b.tab.group) return a.tab.group === "main" ? -1 : 1;
    return a.order - b.order;
  });
  const closed = Array.isArray(record["closed"])
    ? record["closed"].flatMap((value) => {
        const entry = readStoredTab(value);
        return entry === undefined ? [] : [entry];
      })
    : [];
  const active = recordOf(record["active"]);
  const activeMain = active?.["main"];
  const activeCompanion = active?.["companion"];
  const seenSessions = Array.isArray(record["seenSessions"])
    ? record["seenSessions"].filter((id): id is string => typeof id === "string")
    : [];
  const ordered = tabs.map((entry) => entry.tab);
  return {
    tabs: ordered,
    active: {
      ...(typeof activeMain === "string" ? { main: activeMain } : {}),
      ...(typeof activeCompanion === "string" ? { companion: activeCompanion } : {}),
    },
    companionOpen: record["companionOpen"] === true,
    closed,
    seenSessions,
  };
}
