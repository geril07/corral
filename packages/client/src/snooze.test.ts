import type { SnoozePreset } from "@corral/protocol/config";
import type { AgentStatus, Session, Task } from "@corral/protocol/rpc";
import { describe, expect, test } from "vite-plus/test";
import {
  canSnoozeTask,
  customSnoozeUntil,
  isSnoozeWokeUnseen,
  isTaskSnoozed,
  nextSnoozeWake,
  pickSnoozeChoice,
  resolveSnoozeChoices,
  snoozeWakeLabel,
  snoozeWokeAt,
} from "./snooze.ts";

const NOW = new Date(2026, 10, 17, 10, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function clockTime(at: Date): string {
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

function status(state: AgentStatus["state"], updatedAt: number): AgentStatus {
  return { state, updatedAt };
}

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    taskId: "task-1",
    kind: "pi",
    view: "chat",
    agentSessionId: null,
    terminalId: null,
    state: "running",
    status: null,
    createdAt: 0,
    ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    projectId: null,
    title: "A task",
    titleSource: "user",
    prompt: null,
    primarySessionId: null,
    branch: null,
    workspacePath: "/tmp/task-1",
    ownsWorktree: false,
    state: "active",
    seenAt: null,
    snoozedUntil: NOW.getTime() + HOUR,
    snoozedAt: NOW.getTime(),
    createdAt: 0,
    ...overrides,
  };
}

describe("the wake rule", () => {
  test("a wake time in the future hides the task, a passed one does not", () => {
    const noon = NOW.getTime() + 2 * HOUR;
    expect(isTaskSnoozed(task(), [], NOW.getTime())).toBe(true);
    expect(isTaskSnoozed(task(), [], noon)).toBe(false);
    expect(isTaskSnoozed(task({ snoozedUntil: null, snoozedAt: null }), [], NOW.getTime())).toBe(
      false,
    );
  });

  test("a failure newer than the snooze wakes it; an older failure and a completion do not", () => {
    const setAt = NOW.getTime();
    expect(
      isTaskSnoozed(
        task({ snoozedAt: setAt }),
        [session("s", { status: status("error", setAt + 1) })],
        setAt + 30 * 60 * 1000,
      ),
    ).toBe(false);
    expect(
      isTaskSnoozed(
        task({ snoozedAt: setAt }),
        [session("s", { status: status("error", setAt - 1) })],
        setAt + 30 * 60 * 1000,
      ),
    ).toBe(true);
    expect(
      isTaskSnoozed(
        task({ snoozedAt: setAt }),
        [session("s", { status: status("done", setAt + 1) })],
        setAt + 30 * 60 * 1000,
      ),
    ).toBe(true);
  });

  test("an agent waiting on the user wakes the task at any age and cannot be snoozed", () => {
    const waiting = [session("s", { status: { ...status("blocked", 0), kind: "permission" } })];
    const at = NOW.getTime();
    expect(isTaskSnoozed(task({ snoozedAt: at }), waiting, at + HOUR)).toBe(false);
    expect(canSnoozeTask(waiting)).toBe(false);
    expect(canSnoozeTask([session("s", { status: status("working", at) })])).toBe(true);
  });

  test("the next wake is the soonest future one, and nothing when every snooze has passed", () => {
    const at = NOW.getTime();
    expect(
      nextSnoozeWake(
        [
          { snoozedUntil: at + 3 * HOUR },
          { snoozedUntil: at - HOUR },
          { snoozedUntil: at + HOUR },
          { snoozedUntil: null },
        ],
        at,
      ),
    ).toBe(at + HOUR);
    expect(nextSnoozeWake([{ snoozedUntil: at - 1 }], at)).toBeNull();
  });
});

test("the latest label names the largest unit that divides evenly", () => {
  const at = NOW.getTime();
  expect(snoozeWakeLabel(at + 90 * 1000, at)).toBe("2m");
  expect(snoozeWakeLabel(at + HOUR, at)).toBe("1h");
  expect(snoozeWakeLabel(at + 2 * DAY, at)).toBe("2d");
  expect(snoozeWakeLabel(at - HOUR, at)).toBe("now");
});

describe("presets", () => {
  const presets: readonly SnoozePreset[] = [
    { kind: "after", minutes: 180 },
    { kind: "after", minutes: 60 },
    { kind: "at", day: "today", time: "18:00" },
    { kind: "at", day: "tomorrow", time: "09:00" },
    { kind: "at", day: "monday", time: "09:00" },
  ];
  // Tuesday 17 November 2026, 10:00 local; `clockTime` is shared by every case below.

  test("the menu is soonest first and names each wake", () => {
    expect(
      resolveSnoozeChoices(presets, NOW, clockTime).map((choice) => [choice.label, choice.when]),
    ).toEqual([
      ["In 1 hour", "11:00"],
      ["In 3 hours", "13:00"],
      ["This evening", "18:00"],
      ["Tomorrow", "09:00"],
      ["Next week", "Mon 09:00"],
    ]);
  });

  test("a local time already passed today drops out of the menu", () => {
    const evening = new Date(2026, 10, 17, 19, 0, 0);
    expect(
      resolveSnoozeChoices([{ kind: "at", day: "today", time: "18:00" }], evening, clockTime),
    ).toEqual([]);
  });

  test("tomorrow keeps its wall-clock time on the next calendar day, not 24 hours later", () => {
    for (const day of [new Date(2026, 2, 28, 23, 30), new Date(2026, 9, 24, 23, 30)]) {
      const [choice] = resolveSnoozeChoices(
        [{ kind: "at", day: "tomorrow", time: "09:00" }],
        day,
        clockTime,
      );
      const wake = new Date(choice!.until);
      expect([wake.getHours(), wake.getMinutes()]).toEqual([9, 0]);
      expect([wake.getDate(), wake.getMonth()]).toEqual([
        new Date(day.getTime()).getDate() + 1,
        day.getMonth(),
      ]);
    }
  });

  test("two presets waking in the same minute collapse to the first one listed", () => {
    const now = new Date(2026, 10, 17, 17, 0, 30);
    const choices = resolveSnoozeChoices(
      [
        { kind: "after", minutes: 60 },
        { kind: "at", day: "today", time: "18:00" },
      ],
      now,
      clockTime,
    );
    expect(choices.map((choice) => choice.label)).toEqual(["This evening"]);
  });

  test("a picked duration starts at the pick, and a picked time keeps the instant shown", () => {
    const shown = resolveSnoozeChoices(presets, NOW, clockTime);
    const later = new Date(NOW.getTime() + 10 * 60 * 1000);
    const duration = pickSnoozeChoice({
      shown,
      presets,
      id: "after:60",
      now: later,
      formatTime: clockTime,
    });
    expect(duration).toBe(later.getTime() + HOUR);
    const atTime = pickSnoozeChoice({
      shown,
      presets,
      id: "at:today:18:00",
      now: later,
      formatTime: clockTime,
    });
    expect(atTime).toBe(shown.find((choice) => choice.id === "at:today:18:00")!.until);
    expect(
      pickSnoozeChoice({
        shown,
        presets,
        id: "at:today:18:00",
        now: new Date(2026, 10, 17, 19),
        formatTime: clockTime,
      }),
    ).toBeNull();
  });
});

describe("a custom time", () => {
  test("a duration is added to now and capped at 30 days", () => {
    expect(customSnoozeUntil({ mode: "duration", amount: "90", unit: "minutes" }, NOW)).toBe(
      NOW.getTime() + 90 * 60 * 1000,
    );
    expect(customSnoozeUntil({ mode: "duration", amount: "31", unit: "days" }, NOW)).toBeNull();
    expect(customSnoozeUntil({ mode: "duration", amount: "0", unit: "hours" }, NOW)).toBeNull();
    expect(customSnoozeUntil({ mode: "duration", amount: "soon", unit: "hours" }, NOW)).toBeNull();
  });

  test("a date and time must exist locally and lie in the future", () => {
    expect(customSnoozeUntil({ mode: "date", date: "2026-11-18", time: "09:00" }, NOW)).toBe(
      new Date(2026, 10, 18, 9, 0).getTime(),
    );
    expect(customSnoozeUntil({ mode: "date", date: "2026-02-30", time: "09:00" }, NOW)).toBeNull();
    expect(customSnoozeUntil({ mode: "date", date: "2026-11-17", time: "09:00" }, NOW)).toBeNull();
    expect(customSnoozeUntil({ mode: "date", date: "2026-11-18", time: "9:00" }, NOW)).toBeNull();
    expect(customSnoozeUntil({ mode: "date", date: "2027-01-18", time: "09:00" }, NOW)).toBeNull();
  });
});

describe("the Woke notice", () => {
  test("an on-time wake counts from the scheduled instant until the task is looked at", () => {
    const until = NOW.getTime() + HOUR;
    const snoozed = { snoozedUntil: until, snoozedAt: NOW.getTime(), state: "active" as const };
    expect(snoozeWokeAt(snoozed, [], until - 1)).toBeNull();
    expect(snoozeWokeAt(snoozed, [], until)).toBe(until);
    expect(isSnoozeWokeUnseen({ ...snoozed, seenAt: null }, [], until)).toBe(true);
    // A visit before the wake leaves it unseen; a visit after it clears the notice.
    expect(isSnoozeWokeUnseen({ ...snoozed, seenAt: until - 1 }, [], until)).toBe(true);
    expect(isSnoozeWokeUnseen({ ...snoozed, seenAt: until }, [], until)).toBe(false);
  });

  test("an early wake counts from the hand that raised it, not from the scheduled time", () => {
    const at = NOW.getTime();
    const until = at + HOUR;
    const snoozed = { snoozedUntil: until, snoozedAt: at - 1000, state: "active" as const };
    const waiting = [session("s", { status: { ...status("blocked", at + 5), kind: "question" } })];
    expect(snoozeWokeAt(snoozed, waiting, at + 10)).toBe(at + 5);
    expect(isSnoozeWokeUnseen({ ...snoozed, seenAt: at }, waiting, at + 10)).toBe(true);
    expect(isSnoozeWokeUnseen({ ...snoozed, seenAt: at + 5 }, waiting, at + 10)).toBe(false);
  });

  test("a wake that landed on time stays the wake, even when a failure follows it", () => {
    // The snooze ended long ago; the field is stale, not a still-running snooze that an error cut
    // short. Otherwise every later failure would revive a Woke notice for an old snooze.
    const until = NOW.getTime() - HOUR;
    const stale = { snoozedUntil: until, snoozedAt: until - HOUR, state: "active" as const };
    const failed = [session("s", { status: status("error", until + 5) })];
    expect(snoozeWokeAt(stale, failed, NOW.getTime())).toBe(until);
    expect(isSnoozeWokeUnseen({ ...stale, seenAt: until + 1 }, failed, NOW.getTime())).toBe(false);
  });

  test("a task that is still snoozed, settled, or failed before the snooze has no notice", () => {
    const at = NOW.getTime();
    const until = at + HOUR;
    expect(
      snoozeWokeAt({ snoozedUntil: until, snoozedAt: at, state: "active" }, [], at),
    ).toBeNull();
    expect(
      snoozeWokeAt({ snoozedUntil: until, snoozedAt: at, state: "settled" }, [], at + HOUR * 2),
    ).toBeNull();
    expect(
      snoozeWokeAt(
        { snoozedUntil: at, snoozedAt: at, state: "active" },
        [session("s", { status: status("error", at - 1) })],
        at,
      ),
    ).toBe(at);
  });
});
