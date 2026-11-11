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
  reopenLast,
  selectTab,
  serializeLayout,
  sessionTabAt,
  tabId,
  tabNumber,
  tabsInGroup,
  toggleCompanion,
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
    expect(l.companionOpen).toBe(false);
  });

  test("has no fake tab when the task has no sessions", () => {
    const l = defaultLayout(task(null), []);
    expect(l.tabs).toEqual([]);
    expect(l.active).toEqual({ main: undefined });
  });
});

describe("closing and reopening views", () => {
  test("closing an auxiliary session keeps the session but removes its view", () => {
    const l = selectTab(layout(), "session:s2");
    const closed = closeTab(l, "session:s2", "s1");
    expect(ids(closed)).toEqual(["session:s1", "session:s3"]);
    expect(closed.closed.map((entry) => tabId(entry.tab))).toEqual(["session:s2"]);
    expect(closed.active.main).toBe("session:s3");
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

  test("reopen puts the view back in its group at its old order and activates it", () => {
    const l = closeTab(layout(), "session:s2", "s1");
    const reopened = reopenLast(l, task("s1"), SESSIONS);
    expect(ids(reopened)).toEqual(["session:s1", "session:s2", "session:s3"]);
    expect(reopened.active.main).toBe("session:s2");
    expect(reopened.closed).toEqual([]);
  });

  test("a session removed by the server is not reopened", () => {
    const l = closeTab(layout(), "session:s2", "s1");
    const without = SESSIONS.filter((each) => each.id !== "s2");
    const reopened = reopenLast(l, task("s1"), without);
    expect(ids(reopened)).toEqual(["session:s1", "session:s3"]);
  });

  test("every closed view stays in the stack, so a running session never strands", () => {
    let l = layout();
    for (let index = 0; index < 25; index += 1) {
      l = addTab(l, { kind: "session", sessionId: `extra-${index}`, group: "main" });
      l = closeTab(l, `session:extra-${index}`, "s1");
    }
    expect(l.closed).toHaveLength(25);
    expect(tabId(l.closed[0]!.tab)).toBe("session:extra-0");
    expect(tabId(l.closed.at(-1)!.tab)).toBe("session:extra-24");
  });
});

describe("the companion group", () => {
  test("Changes lives in the companion group and selecting it leaves the main session alone", () => {
    const l = addTab(layout(), { kind: "changes", group: "companion" });
    expect(l.companionOpen).toBe(true);
    expect(l.active.companion).toBe("changes");
    expect(l.active.main).toBe("session:s1");
    const selected = selectTab(l, "changes");
    expect(selected.active.main).toBe("session:s1");
  });

  test("closing the last companion tab collapses the group and keeps the other tabs", () => {
    const l = addTab(layout(), { kind: "changes", group: "companion" });
    const closed = closeTab(l, "changes", "s1");
    expect(closed.companionOpen).toBe(false);
    expect(closed.active.companion).toBeUndefined();
    expect(ids(closed)).toEqual(["session:s1", "session:s2", "session:s3"]);
  });

  test("reopening a companion tab restores the group and its order", () => {
    const l = closeTab(addTab(layout(), { kind: "changes", group: "companion" }), "changes", "s1");
    const reopened = reopenLast(l, task("s1"), SESSIONS);
    expect(reopened.companionOpen).toBe(true);
    expect(reopened.active.companion).toBe("changes");
    expect(tabsInGroup(reopened, "companion").map(tabId)).toEqual(["changes"]);
  });

  test("toggling an empty group opens Changes instead of an empty half", () => {
    const l = toggleCompanion(layout());
    expect(l.companionOpen).toBe(true);
    expect(tabsInGroup(l, "companion").map(tabId)).toEqual(["changes"]);
    expect(toggleCompanion(l).companionOpen).toBe(false);
  });
});

describe("moving tabs between groups", () => {
  test("a session moves beside the main group and back", () => {
    const moved = moveTab(layout(), "session:s3", "s1");
    expect(tabsInGroup(moved, "main").map(tabId)).toEqual(["session:s1", "session:s2"]);
    expect(tabsInGroup(moved, "companion").map(tabId)).toEqual(["session:s3"]);
    expect(moved.active.companion).toBe("session:s3");
    expect(moved.companionOpen).toBe(true);

    const back = moveTab(moved, "session:s3", "s1");
    expect(tabsInGroup(back, "main").map(tabId)).toEqual([
      "session:s1",
      "session:s2",
      "session:s3",
    ]);
    expect(back.companionOpen).toBe(false);
  });

  test("the main group always keeps one tab", () => {
    const one = defaultLayout(task("s1"), [SESSIONS[1]!]);
    expect(moveTab(one, "session:s1", "s1")).toBe(one);
  });

  test("Changes belongs to the companion group and does not move", () => {
    const l = addTab(layout(), { kind: "changes", group: "companion" });
    expect(moveTab(l, "changes", "s1")).toBe(l);
  });

  test("the primary session stays first and does not move", () => {
    const l = layout();
    expect(moveTab(l, "session:s1", "s1")).toBe(l);
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

  test("a closed view stays closed after a reload", () => {
    const l = closeTab(layout(), "session:s2", "s1");
    const reloaded = reconcileLayout(parseLayout(serializeLayout(l)), task("s1"), SESSIONS);
    expect(ids(reloaded)).toEqual(["session:s1", "session:s3"]);
    expect(reloaded.closed.map((entry) => tabId(entry.tab))).toEqual(["session:s2"]);
  });

  test("a task never opened on this device gets the default layout", () => {
    expect(reconcileLayout(undefined, task("s1"), SESSIONS)).toEqual(layout());
  });

  test("a stored primary in the companion is normalised to the first main tab", () => {
    const stored: TaskTabLayout = {
      tabs: [
        { kind: "session", sessionId: "s1", group: "companion" },
        { kind: "session", sessionId: "s2", group: "main" },
      ],
      active: { main: "session:s2", companion: "session:s1" },
      companionOpen: true,
      closed: [],
      seenSessions: ["s1", "s2"],
    };
    const next = reconcileLayout(stored, task("s1"), SESSIONS);
    expect(tabsInGroup(next, "main").map(tabId)).toEqual([
      "session:s1",
      "session:s2",
      "session:s3",
    ]);
    expect(tabsInGroup(next, "companion")).toEqual([]);
    expect(next.active.main).toBe("session:s2");
    expect(next.companionOpen).toBe(false);
  });
});

describe("the device-local record", () => {
  test("round-trips tab identity, group, order, active tabs and the closed stack", () => {
    let l = addTab(layout(), { kind: "changes", group: "companion" });
    l = moveTab(l, "session:s3", "s1");
    l = closeTab(l, "session:s2", "s1");
    const stored = serializeLayout(l);
    expect(parseLayout(stored)).toEqual(l);
  });

  test("rejects malformed and unknown records instead of dropping the task's layout", () => {
    expect(parseLayout(null)).toBeUndefined();
    expect(parseLayout("{")).toBeUndefined();
    expect(parseLayout(JSON.stringify({ version: 2, tabs: [] }))).toBeUndefined();
    expect(
      parseLayout('{"version":1,"tabs":[{"kind":"changes","group":"companion","order":1e999}]}'),
    ).toEqual({
      tabs: [],
      active: {},
      companionOpen: false,
      closed: [],
      seenSessions: [],
    });
    expect(
      parseLayout(JSON.stringify({ version: 1, tabs: [{ kind: "unknown", group: "main" }] })),
    ).toEqual({
      tabs: [],
      active: {},
      companionOpen: false,
      closed: [],
      seenSessions: [],
    });
  });
});

describe("numbers and stepping", () => {
  test("session tabs are numbered inside their own group; Changes is not numbered", () => {
    let l = addTab(layout(), { kind: "changes", group: "companion" });
    expect(sessionTabAt(l, "main", 1)).toMatchObject({ sessionId: "s1" });
    expect(sessionTabAt(l, "companion", 1)).toBeUndefined();
    expect(activeTab(l, "companion")).toMatchObject({ kind: "changes" });
    expect(tabNumber(l, "session:s2")).toBe(2);
    expect(tabNumber(l, "changes")).toBeUndefined();

    // A session beside Changes is the companion group's first session, not its second tab.
    l = moveTab(l, "session:s2", "s1");
    expect(tabsInGroup(l, "companion").map(tabId)).toEqual(["changes", "session:s2"]);
    expect(tabNumber(l, "session:s2")).toBe(1);
    expect(sessionTabAt(l, "companion", 1)).toMatchObject({ sessionId: "s2" });
  });
});

describe("removing a session", () => {
  test("drops the tab, the closed entry and the seen mark", () => {
    let l = closeTab(layout(), "session:s2", "s1");
    l = removeSession(l, "s2");
    expect(ids(l)).toEqual(["session:s1", "session:s3"]);
    expect(l.closed).toEqual([]);
    expect(l.seenSessions).not.toContain("s2");
  });
});
