import type { AgentStatus, Project, Session, Task } from "@corral/protocol/rpc";
import { describe, expect, test } from "vite-plus/test";
import {
  buildTaskRows,
  cardPriority,
  cardStatus,
  formatCompactAge,
  primaryTaskStatus,
} from "./visual-status.ts";

const NOW = 1_800_000_000_000;
const PROJECT: Project = {
  id: "project-1",
  name: "orbit",
  path: "/repos/orbit",
  defaultBaseBranch: "main",
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
