import type { Session, Task } from "@corral/protocol/rpc";
import { describe, expect, test } from "vite-plus/test";
import {
  addTab,
  activeTab,
  closeTab,
  defaultLayout,
  moveTab,
  parseLayout,
  reconcileLayout,
  removeSession,
  selectTab,
  serializeLayout,
  sessionTabAt,
  tabId,
  tabNumber,
  tabsInGroup,
  focusGroup,
  toggleExpanded,
  type TaskTabLayout,
} from "./task-tabs.ts";

function session(id: string, kind: Session["kind"], createdAt: number): Session {
  return {
    id,
    taskId: "task-1",
    kind,
    view: kind === "shell" ? "terminal" : "chat",
    agentSessionId: null,
    terminalId: null,
    state: "running",
    status: null,
    createdAt,
  };
}

function task(primarySessionId: string | null = "s1"): Task {
  return {
    id: "task-1",
    projectId: "project-1",
    title: "Tabs",
    titleSource: "seed",
    prompt: null,
    primarySessionId,
    branch: null,
    workspacePath: "/tmp/task-1",
    ownsWorktree: false,
    state: "active",
    seenAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    createdAt: 0,
  };
}

const SESSIONS = [session("s2", "shell", 20), session("s1", "pi", 10), session("s3", "claude", 30)];

function layout(primarySessionId: string | null = "s1"): TaskTabLayout {
  return defaultLayout(task(primarySessionId), SESSIONS);
}

function ids(l: TaskTabLayout): string[] {
  return l.tabs.map(tabId);
}

describe("the default working area", () => {
  test("puts the primary session first and the rest in creation order", () => {
    const l = layout();
    expect(ids(l)).toEqual(["session:s1", "session:s2", "session:s3"]);
    expect(l.active.main).toBe("session:s1");
    expect(l.expanded).toBeNull();
  });

  test("has no fake tab when the task has no sessions", () => {
    const l = defaultLayout(task(null), []);
    expect(l.tabs).toEqual([]);
    expect(l.active).toEqual({ main: undefined });
  });
});

describe("closing views", () => {
  test("closing an auxiliary session removes its view and keeps it out of the strip", () => {
    const l = selectTab(layout(), "session:s2");
    const closed = closeTab(l, "session:s2", "s1");
    expect(ids(closed)).toEqual(["session:s1", "session:s3"]);
    expect(closed.active.main).toBe("session:s3");
    // The session was shown, so a reload does not treat it as a new session and re-add it.
    expect(closed.seenSessions).toContain("s2");
  });

  test("the primary session is not a closable view", () => {
    const l = layout();
    expect(closeTab(l, "session:s1", "s1")).toBe(l);
  });

  test("close falls to the right, then the left, then the group's home", () => {
    let l = selectTab(layout(), "session:s2");
    l = closeTab(l, "session:s2", "s1");
    expect(l.active.main).toBe("session:s3");
    l = closeTab(l, "session:s3", "s1");
    expect(l.active.main).toBe("session:s1");
  });

  test("closing a session does not leave a history entry behind", () => {
    let l = layout();
    for (let index = 0; index < 25; index += 1) {
      l = addTab(l, { kind: "session", sessionId: `extra-${index}`, group: "main" });
      l = closeTab(l, `session:extra-${index}`, "s1");
    }
    expect(ids(l)).toEqual(["session:s1", "session:s2", "session:s3"]);
    expect(l.seenSessions).toContain("extra-24");
  });
});

const FILE_TAB = { kind: "file", path: "src/a.ts", group: "companion" } as const;
const TERMINAL_TAB = { kind: "terminal", terminalId: "t1", group: "companion" } as const;

describe("a loose terminal's view", () => {
  test("opens as its own tab and closes without touching the task's sessions", () => {
    const l = addTab(layout(), TERMINAL_TAB);
    expect(l.active.companion).toBe("terminal:t1");
    expect(l.focused).toBe("companion");

    const closed = closeTab(l, "terminal:t1", "s1");
    expect(ids(closed)).toEqual(["session:s1", "session:s2", "session:s3"]);
    expect(closed.active.companion).toBeUndefined();
  });

  test("survives reconciliation while the server's sessions change", () => {
    const l = addTab(layout(), TERMINAL_TAB);
    const next = reconcileLayout(l, task("s1"), [...SESSIONS, session("s4", "shell", 40)]);
    expect(ids(next)).toEqual([
      "session:s1",
      "session:s2",
      "session:s3",
      "terminal:t1",
      "session:s4",
    ]);
    expect(next.active.companion).toBe("terminal:t1");
  });
});

describe("the companion group", () => {
  test("a file view has its own active tab and leaves the main session alone", () => {
    const l = addTab(layout(), FILE_TAB);
    expect(l.focused).toBe("companion");
    expect(l.active.companion).toBe("file:src/a.ts");
    expect(l.active.main).toBe("session:s1");
    const selected = selectTab(l, "file:src/a.ts");
    expect(selected.active.main).toBe("session:s1");
  });

  test("closing the last companion tab collapses the group and keeps the other tabs", () => {
    const l = addTab(layout(), FILE_TAB);
    const closed = closeTab(l, "file:src/a.ts", "s1");
    expect(closed.expanded).toBeNull();
    expect(closed.active.companion).toBeUndefined();
    expect(ids(closed)).toEqual(["session:s1", "session:s2", "session:s3"]);
  });

  test("expansion requires two groups and is reversible", () => {
    const l = layout();
    expect(toggleExpanded(l, "main")).toBe(l);

    const withFile = addTab(l, FILE_TAB);
    const expanded = toggleExpanded(withFile, "companion");
    expect(expanded.expanded).toBe("companion");
    const focusedMain = focusGroup(expanded, "main");
    expect(focusedMain.expanded).toBe("main");
    expect(toggleExpanded(focusedMain, "main").expanded).toBeNull();
  });
});

describe("moving tabs between groups", () => {
  test("a session moves beside the main group and back", () => {
    const moved = moveTab(layout(), "session:s3", "companion");
    expect(tabsInGroup(moved, "main").map(tabId)).toEqual(["session:s1", "session:s2"]);
    expect(tabsInGroup(moved, "companion").map(tabId)).toEqual(["session:s3"]);
    expect(moved.active.companion).toBe("session:s3");
    expect(moved.focused).toBe("companion");

    const back = moveTab(moved, "session:s3", "main");
    expect(tabsInGroup(back, "main").map(tabId)).toEqual([
      "session:s1",
      "session:s2",
      "session:s3",
    ]);
    expect(back.expanded).toBeNull();
  });

  test("moving the last tab collapses the empty group without losing the tab", () => {
    const one = defaultLayout(task("s1"), [SESSIONS[1]!]);
    const moved = moveTab(one, "session:s1", "companion");
    expect(tabsInGroup(moved, "main")).toEqual([]);
    expect(tabsInGroup(moved, "companion").map(tabId)).toEqual(["session:s1"]);
    expect(moved.focused).toBe("companion");
    expect(moved.expanded).toBeNull();
  });

  test("the primary can be reordered and moved without becoming closable", () => {
    const reordered = moveTab(layout(), "session:s1", "main", 2);
    expect(tabsInGroup(reordered, "main").map(tabId)).toEqual([
      "session:s2",
      "session:s3",
      "session:s1",
    ]);
    const moved = moveTab(reordered, "session:s1", "companion");
    expect(tabsInGroup(moved, "companion").map(tabId)).toEqual(["session:s1"]);
    expect(closeTab(moved, "session:s1", "s1")).toBe(moved);
  });
});

describe("reconciling with the server", () => {
  test("a new session joins the main group, and a removed one loses its tab", () => {
    const l = layout();
    const withNew = [...SESSIONS, session("s4", "shell", 40)];
    const next = reconcileLayout(l, task("s1"), withNew);
    expect(ids(next)).toEqual(["session:s1", "session:s2", "session:s3", "session:s4"]);

    const withoutS2 = withNew.filter((each) => each.id !== "s2");
    const dropped = reconcileLayout(next, task("s1"), withoutS2);
    expect(ids(dropped)).toEqual(["session:s1", "session:s3", "session:s4"]);
    expect(dropped.seenSessions).not.toContain("s2");
  });

  test("a closed view stays closed after a reload even though its session is still listed", () => {
    const l = closeTab(layout(), "session:s2", "s1");
    const reloaded = reconcileLayout(parseLayout(serializeLayout(l)), task("s1"), SESSIONS);
    expect(ids(reloaded)).toEqual(["session:s1", "session:s3"]);
  });

  test("a task never opened on this device gets the default layout", () => {
    expect(reconcileLayout(undefined, task("s1"), SESSIONS)).toEqual(layout());
  });

  test("a stored primary keeps its group and position after reconciliation", () => {
    const stored: TaskTabLayout = {
      tabs: [
        { kind: "session", sessionId: "s1", group: "companion" },
        { kind: "session", sessionId: "s2", group: "main" },
      ],
      active: { main: "session:s2", companion: "session:s1" },
      focused: "companion",
      expanded: null,
      companionWidth: 420,
      seenSessions: ["s1", "s2"],
    };
    const next = reconcileLayout(stored, task("s1"), SESSIONS);
    expect(tabsInGroup(next, "main").map(tabId)).toEqual(["session:s2", "session:s3"]);
    expect(tabsInGroup(next, "companion").map(tabId)).toEqual(["session:s1"]);
    expect(next.active.main).toBe("session:s2");
    expect(next.focused).toBe("companion");
    expect(next.companionWidth).toBe(420);
  });
});

describe("the device-local record", () => {
  test("round-trips tab identity, group, order and active tabs", () => {
    let l = addTab(layout(), FILE_TAB);
    l = moveTab(l, "session:s3", "companion");
    l = { ...toggleExpanded(l, "companion"), companionWidth: 450 };
    l = closeTab(l, "session:s2", "s1");
    const stored = serializeLayout(l);
    expect(parseLayout(stored)).toEqual(l);
  });

  test("round-trips a loose terminal's tab", () => {
    const l = addTab(layout(), TERMINAL_TAB);
    expect(parseLayout(serializeLayout(l))).toEqual(l);
  });

  test("drops a terminal tab whose terminal id is missing", () => {
    const stored = JSON.stringify({
      version: 2,
      tabs: [{ kind: "terminal", group: "main", order: 0 }],
      active: { main: "terminal:" },
      focused: "main",
      expanded: null,
      companionWidth: 600,
      seenSessions: [],
    });
    expect(parseLayout(stored)).toMatchObject({ tabs: [], active: {} });
  });

  test("reads a record that still carries the removed closed-tab history without it", () => {
    const stored = JSON.stringify({
      version: 1,
      tabs: [{ kind: "session", sessionId: "s1", group: "main", order: 0 }],
      active: { main: "session:s1" },
      companionOpen: false,
      closed: [{ kind: "session", sessionId: "s2", group: "main", order: 1 }],
      seenSessions: ["s1", "s2"],
    });
    expect(parseLayout(stored)).toEqual({
      tabs: [{ kind: "session", sessionId: "s1", group: "main" }],
      active: { main: "session:s1" },
      focused: "main",
      expanded: null,
      companionWidth: 600,
      seenSessions: ["s1", "s2"],
    });
    const reloaded = reconcileLayout(parseLayout(stored), task("s1"), SESSIONS);
    expect(ids(reloaded)).toEqual(["session:s1", "session:s3"]);
  });

  test("reads a record that still carries a changes tab without it", () => {
    const stored = JSON.stringify({
      version: 1,
      tabs: [
        { kind: "session", sessionId: "s1", group: "main", order: 0 },
        { kind: "changes", group: "companion", order: 0 },
      ],
      active: { main: "session:s1", companion: "changes" },
      companionOpen: true,
      seenSessions: ["s1"],
    });
    expect(parseLayout(stored)).toEqual({
      tabs: [{ kind: "session", sessionId: "s1", group: "main" }],
      active: { main: "session:s1" },
      focused: "main",
      expanded: null,
      companionWidth: 600,
      seenSessions: ["s1"],
    });
    const reloaded = reconcileLayout(parseLayout(stored), task("s1"), SESSIONS);
    expect(tabsInGroup(reloaded, "companion")).toEqual([]);
    expect(reloaded.expanded).toBeNull();
    expect(reloaded.active.main).toBe("session:s1");
  });

  test("migrates a hidden companion and its previous global width", () => {
    const stored = JSON.stringify({
      version: 1,
      tabs: [
        { kind: "session", sessionId: "s1", group: "main", order: 0 },
        { kind: "session", sessionId: "s2", group: "companion", order: 0 },
      ],
      active: { main: "session:s1", companion: "session:s2" },
      companionOpen: false,
      seenSessions: ["s1", "s2"],
    });
    expect(parseLayout(stored, 432)).toMatchObject({
      focused: "main",
      expanded: "main",
      companionWidth: 432,
    });
  });

  test("rejects malformed and unknown records instead of dropping the task's layout", () => {
    expect(parseLayout(null)).toBeUndefined();
    expect(parseLayout("{")).toBeUndefined();
    expect(parseLayout(JSON.stringify({ version: 3, tabs: [] }))).toBeUndefined();
    expect(
      parseLayout(
        '{"version":1,"tabs":[{"kind":"file","path":"a.ts","group":"companion","order":1e999}]}',
      ),
    ).toEqual({
      tabs: [],
      active: {},
      focused: "main",
      expanded: null,
      companionWidth: 600,
      seenSessions: [],
    });
    expect(
      parseLayout(JSON.stringify({ version: 1, tabs: [{ kind: "unknown", group: "main" }] })),
    ).toEqual({
      tabs: [],
      active: {},
      focused: "main",
      expanded: null,
      companionWidth: 600,
      seenSessions: [],
    });
  });
});

describe("numbers and stepping", () => {
  test("session tabs are numbered inside their own group; a file tab is not numbered", () => {
    let l = addTab(layout(), FILE_TAB);
    expect(sessionTabAt(l, "main", 1)).toMatchObject({ sessionId: "s1" });
    expect(sessionTabAt(l, "companion", 1)).toBeUndefined();
    expect(activeTab(l, "companion")).toMatchObject({ kind: "file" });
    expect(tabNumber(l, "session:s2")).toBe(2);
    expect(tabNumber(l, "file:src/a.ts")).toBeUndefined();

    // A session beside a file view is the companion group's first session, not its second tab.
    l = moveTab(l, "session:s2", "companion");
    expect(tabsInGroup(l, "companion").map(tabId)).toEqual(["file:src/a.ts", "session:s2"]);
    expect(tabNumber(l, "session:s2")).toBe(1);
    expect(sessionTabAt(l, "companion", 1)).toMatchObject({ sessionId: "s2" });
  });
});

describe("removing a session", () => {
  test("drops the tab and the seen mark", () => {
    let l = closeTab(layout(), "session:s2", "s1");
    l = removeSession(l, "s2");
    expect(ids(l)).toEqual(["session:s1", "session:s3"]);
    expect(l.seenSessions).not.toContain("s2");
  });
});
