import type { AgentState, AgentStatus, Session } from "@corral/protocol/rpc";
import * as fc from "fast-check";
import { expect, test } from "vite-plus/test";
import {
  describeStatus,
  formatAge,
  hasUnseen,
  isSeenDone,
  isUnseenDone,
  sessionStatus,
  STATES_BY_URGENCY,
  taskStatus,
  urgencyRank,
} from "./agent-status.ts";

/** The part of a task the unseen checks read. */
const seenTask = (seenAt: number | null) => ({ seenAt });
const status = (state: AgentState, updatedAt = 0, kind?: AgentStatus["kind"]): AgentStatus => ({
  state,
  updatedAt,
  ...(kind ? { kind } : {}),
});
const session = (
  id: string,
  state: Session["state"],
  reported: AgentStatus | null,
): Pick<Session, "id" | "state" | "status"> => ({ id, state, status: reported });

test("a task is as urgent as its most urgent session: blocked, error, working, done, idle", () => {
  const sessions = [
    session("idle", "running", status("idle")),
    session("done", "running", status("done")),
    session("working", "running", status("working")),
    session("error", "running", status("error")),
    session("blocked", "running", status("blocked", 0, "permission")),
  ];
  for (const [index, expected] of STATES_BY_URGENCY.entries()) {
    const lessUrgent = sessions.filter((each) => urgencyRank(each.status?.state) >= index);
    expect(taskStatus(lessUrgent)?.status.state).toBe(expected);
  }
  expect(taskStatus(sessions)?.sessionId).toBe("blocked");
});

test("the order of urgency is the one the design states", () => {
  expect(STATES_BY_URGENCY).toEqual(["blocked", "error", "working", "done", "idle"]);
});

test("a task with no reporting session has no status", () => {
  expect(taskStatus([])).toBeUndefined();
  expect(taskStatus([session("shell", "running", null)])).toBeUndefined();
});

test("of equal urgency the latest report gives the task its status", () => {
  const sessions = [
    session("old", "running", status("blocked", 10)),
    session("new", "running", status("blocked", 20)),
    session("older", "running", status("blocked", 5)),
  ];
  expect(taskStatus(sessions)?.sessionId).toBe("new");
});

test("a stopped session keeps only the done or error it reported", () => {
  expect(sessionStatus(session("s", "stopped", status("done")))?.state).toBe("done");
  expect(sessionStatus(session("s", "unresumable", status("error")))?.state).toBe("error");
  for (const stale of ["working", "blocked", "idle"] as const) {
    expect(sessionStatus(session("s", "stopped", status(stale)))).toBeUndefined();
  }
  expect(
    taskStatus([
      session("gone", "stopped", status("blocked")),
      session("live", "running", status("working")),
    ])?.sessionId,
  ).toBe("live");
});

const arbitrarySession = fc.record({
  id: fc.uuid(),
  state: fc.constantFrom<Session["state"]>("running", "stopped", "unresumable"),
  status: fc.option(
    fc.record({
      state: fc.constantFrom(...STATES_BY_URGENCY),
      updatedAt: fc.nat(1000),
    }),
    { nil: null },
  ),
});

test("whatever the sessions and their order, no session is more urgent than the task", () => {
  fc.assert(
    fc.property(fc.array(arbitrarySession, { maxLength: 8 }), (sessions) => {
      const result = taskStatus(sessions);
      const ranks = sessions.map((each) => urgencyRank(sessionStatus(each)?.state));
      expect(urgencyRank(result?.status.state)).toBe(Math.min(urgencyRank(undefined), ...ranks));
      expect(urgencyRank(taskStatus(sessions.toReversed())?.status.state)).toBe(
        urgencyRank(result?.status.state),
      );
    }),
  );
});

test("the status text names the state and what a blocked agent waits for", () => {
  expect(describeStatus(status("blocked", 0, "permission"))).toBe("blocked · permission");
  expect(describeStatus(status("working"))).toBe("working");
});

test("ages read at a glance", () => {
  const now = 10_000_000_000;
  expect(formatAge(now, now + 1000)).toBe("now");
  expect(formatAge(now, now - 3000)).toBe("now");
  expect(formatAge(now, now - 42_000)).toBe("42s");
  expect(formatAge(now, now - 5 * 60_000)).toBe("5m");
  expect(formatAge(now, now - 3 * 3_600_000)).toBe("3h");
  expect(formatAge(now, now - 50 * 3_600_000)).toBe("2d");
});

test("a done update newer than the task's seenAt is completed and unseen", () => {
  expect(isUnseenDone(seenTask(null), status("done", 1))).toBe(true);
  expect(isUnseenDone(seenTask(1), status("done", 2))).toBe(true);
  expect(isUnseenDone(seenTask(2), status("done", 2))).toBe(false);
  expect(isUnseenDone(seenTask(3), status("done", 2))).toBe(false);
  expect(isUnseenDone(seenTask(1), status("working", 2))).toBe(false);
  expect(isUnseenDone(seenTask(1), undefined)).toBe(false);

  // The one mute rule both the sidebar row and the task header use.
  expect(isSeenDone(status("done", 1), false)).toBe(true);
  expect(isSeenDone(status("done", 1), true)).toBe(false);
  expect(isSeenDone(status("working", 1), false)).toBe(false);
  expect(isSeenDone(undefined, false)).toBe(false);

  // Any newer status is an update the user has not seen; only `done` marks the task as finished.
  expect(hasUnseen(seenTask(1), status("idle", 2))).toBe(true);
  expect(hasUnseen(seenTask(1), status("blocked", 2, "permission"))).toBe(true);
  expect(hasUnseen(seenTask(2), status("done", 2))).toBe(false);
  expect(hasUnseen(seenTask(null), undefined)).toBe(false);
});
