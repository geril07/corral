import type { AgentStatus, Project, Session, Task, TaskSource } from "@corral/protocol/rpc";
import { describe, expect, test } from "vite-plus/test";
import {
  buildSettledRows,
  buildTaskRows,
  cardPriority,
  cardStatus,
  formatCompactAge,
  primaryTaskStatus,
} from "./visual-status.ts";

const NOW = 1_800_000_000_000;

test("the sidebar retains scratch task title and primary status without a project", () => {
  const primary = session("primary", { status: status("working") });
  const scratch = task("scratch", {
    projectId: null,
    branch: null,
    title: "Scratch title",
    primarySessionId: primary.id,
  });
  expect(buildTaskRows([], [scratch], [primary], NOW)).toMatchObject([
    { title: "Scratch title", project: "No project", status: { label: "Working" } },
  ]);
});
const PROJECT: Project = {
  id: "project-1",
  name: "orbit",
  path: "/repos/orbit",
  defaultBaseBranch: "main",
  pinnedAt: null,
};

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    projectId: PROJECT.id,
    title: `Task ${id}`,
    titleSource: "user",
    prompt: null,
    primarySessionId: null,
    branch: `branch/${id}`,
    workspacePath: `/worktrees/orbit/${id}`,
    ownsWorktree: true,
    state: "active",
    seenAt: null,
    createdAt: NOW - 60_000,
    ...overrides,
  };
}

function status(state: AgentStatus["state"], updatedAt = NOW - 60_000): AgentStatus {
  return { state, updatedAt };
}

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    taskId: "task-1",
    kind: "pi",
    view: "chat",
    agentSessionId: "agent-1",
    terminalId: null,
    state: "running",
    status: null,
    createdAt: NOW - 120_000,
    ...overrides,
  };
}

test("a row keeps its issue source flag and only a real recorded branch to copy", () => {
  const source: TaskSource = {
    provider: "github",
    host: "github.com",
    repository: "acme/app",
    number: 7,
    url: "https://github.com/acme/app/issues/7",
    title: "Imported issue",
    body: "Body",
    fetchedAt: NOW,
  };
  const [imported] = buildTaskRows(
    [PROJECT],
    [task("imported", { source, branch: "feat/imported" })],
    [],
    NOW,
  );
  expect(imported).toMatchObject({ hasSource: true, copyBranch: "feat/imported" });

  const [detached] = buildTaskRows([PROJECT], [task("detached", { branch: "HEAD" })], [], NOW);
  expect(detached?.hasSource).toBe(false);
  expect(detached?.copyBranch).toBeUndefined();

  const [noBranch] = buildTaskRows([PROJECT], [task("no-branch", { branch: null })], [], NOW);
  expect(noBranch?.copyBranch).toBeUndefined();
});

describe("formatCompactAge", () => {
  test("never shows seconds", () => {
    expect(formatCompactAge(NOW, NOW - 1_000)).toBe("<1m");
    expect(formatCompactAge(NOW, NOW - 59_000)).toBe("<1m");
    expect(formatCompactAge(NOW, NOW - 60_000)).toBe("1m");
    expect(formatCompactAge(NOW, NOW - 3_600_000)).toBe("1h");
    expect(formatCompactAge(NOW, NOW - 2 * 86_400_000)).toBe("2d");
  });
});

describe("primary session status", () => {
  test("a task follows its primary session, not an auxiliary terminal running an agent", () => {
    const primary = session("primary", { status: status("idle") });
    const auxiliary = session("auxiliary", { kind: "claude", status: status("working") });
    const selected = task("task-1", { primarySessionId: primary.id });

    expect(primaryTaskStatus(selected, [primary, auxiliary])?.status.state).toBe("idle");
    expect(cardStatus(selected, status("idle"), NOW)).toEqual({
      tone: "neutral",
      muted: true,
      time: "1m",
    });
  });

  test("without a primary session the task shows no agent status at all", () => {
    const auxiliary = session("auxiliary", { status: status("working") });
    expect(primaryTaskStatus(task("task-1"), [auxiliary])).toBeUndefined();
  });

  test("the metadata agent is the primary session's real launch choice, never a shell", () => {
    const primary = session("primary", {
      launch: {
        kind: "pi",
        profile: null,
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        env: [],
      },
    });
    const shell = session("shell", {
      kind: "shell",
      launch: {
        kind: "pi",
        profile: null,
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        env: [],
      },
    });

    const [row] = buildTaskRows(
      [PROJECT],
      [task("task-1", { primarySessionId: primary.id })],
      [primary, shell],
      NOW,
    );
    expect(row?.metadata.agent).toEqual({
      kind: "pi",
      model: "claude-sonnet-4-5",
      provider: "anthropic",
    });

    const [withoutModel] = buildTaskRows(
      [PROJECT],
      [task("task-1", { primarySessionId: "plain" })],
      [session("plain")],
      NOW,
    );
    expect(withoutModel?.metadata.agent).toEqual({ kind: "pi" });

    const [withoutPrimary] = buildTaskRows(
      [PROJECT],
      [task("task-1", { primarySessionId: shell.id })],
      [shell],
      NOW,
    );
    expect(withoutPrimary?.metadata.agent).toBeUndefined();
  });
});

describe("card status", () => {
  test("Working has no time because updatedAt is not a run start", () => {
    const shown = cardStatus(task("task-1"), status("working"), NOW);
    expect(shown).toEqual({ tone: "working", label: "Working", message: undefined });
    expect(shown?.time).toBeUndefined();
  });

  test("Blocked and Error carry their compact report age", () => {
    expect(cardStatus(task("task-1"), status("blocked", NOW - 120_000), NOW)).toMatchObject({
      tone: "blocked",
      label: "Blocked",
      time: "2m",
    });
    expect(cardStatus(task("task-1"), status("error", NOW - 7_200_000), NOW)).toMatchObject({
      tone: "error",
      label: "Error",
      time: "2h",
    });
  });

  test("a seen Done returns to the neutral muted time, an unseen Done keeps the Done label", () => {
    const update = status("done", NOW - 300_000);
    expect(cardStatus(task("task-1", { seenAt: null }), update, NOW)).toMatchObject({
      tone: "done",
      label: "Done",
      time: "5m",
    });
    expect(cardStatus(task("task-1", { seenAt: NOW }), update, NOW)).toEqual({
      tone: "neutral",
      muted: true,
      time: "5m",
    });
  });
});

describe("the Settled shelf's rows", () => {
  test("only settled tasks, marked, in the one order: newest activity, then newest task", () => {
    const tasks: Task[] = [
      task("active-one", { createdAt: NOW - 1_000 }),
      task("old-activity", {
        primarySessionId: "old",
        createdAt: NOW - 90_000,
        state: "settled",
      }),
      task("new-task", { createdAt: NOW - 5_000, state: "settled" }),
      task("recent-activity", {
        primarySessionId: "recent",
        createdAt: NOW - 900_000,
        state: "settled",
      }),
    ];
    const sessions = [
      session("old", {
        taskId: "old-activity",
        state: "stopped",
        status: status("done", NOW - 60_000),
      }),
      session("recent", {
        taskId: "recent-activity",
        state: "stopped",
        status: status("done", NOW - 2_000),
      }),
    ];

    const rows = buildSettledRows([PROJECT], tasks, sessions, NOW);
    expect(rows.map((row) => row.id)).toEqual(["recent-activity", "new-task", "old-activity"]);
    // The state is the server's, carried once into the row the card and the header read.
    expect(rows.every((row) => row.settled === true)).toBe(true);
    // A settled task without a project the client knows has no row, like an active one.
    expect(buildSettledRows([], [{ ...task("orphan"), state: "settled" }], [], NOW)).toEqual([]);
    // The active list stays active-only.
    expect(buildTaskRows([PROJECT], tasks, sessions, NOW).map((row) => row.id)).toEqual([
      "active-one",
    ]);
  });
});

describe("sidebar order", () => {
  test("Blocked/Error, then unseen Done, then Working, then the rest", () => {
    const tasks = [
      task("ordinary", { createdAt: NOW - 10_000 }),
      task("working", { primarySessionId: "working" }),
      task("done-seen", { primarySessionId: "done-seen", seenAt: NOW }),
      task("done-unseen", { primarySessionId: "done-unseen" }),
      task("error", { primarySessionId: "error" }),
      task("blocked", { primarySessionId: "blocked" }),
    ];
    const sessions = [
      session("working", { status: status("working", NOW - 1_000) }),
      session("done-seen", {
        taskId: "done-seen",
        state: "stopped",
        status: status("done", NOW - 2_000),
      }),
      session("done-unseen", {
        taskId: "done-unseen",
        state: "stopped",
        status: status("done", NOW - 3_000),
      }),
      session("error", { taskId: "error", status: status("error", NOW - 4_000) }),
      session("blocked", { taskId: "blocked", status: status("blocked", NOW - 5_000) }),
    ];

    expect(buildTaskRows([PROJECT], tasks, sessions, NOW).map((row) => row.id)).toEqual([
      // Blocked and Error share the attention group; the more recent report comes first.
      "error",
      "blocked",
      "done-unseen",
      "working",
      "done-seen",
      "ordinary",
    ]);
  });

  test("a seen Blocked stays in the attention group until the problem is resolved", () => {
    const shown = cardStatus(task("task-1", { seenAt: NOW }), status("blocked"), NOW);
    expect(cardPriority(task("task-1", { seenAt: NOW }), status("blocked"))).toBe(0);
    expect(shown?.tone).toBe("blocked");
  });
});
