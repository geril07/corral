import type { SnoozePreset, SnoozePresetDay } from "@corral/protocol/config";
import { MAX_SNOOZE_MINUTES } from "@corral/protocol/config";
import type { Session, Task } from "@corral/protocol/rpc";
import { sessionStatus } from "./agent-status.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MAX_SNOOZE_MS = MAX_SNOOZE_MINUTES * MINUTE_MS;

/**
 * A hand raised while snoozed: a session waits on the user now (permission, question or auth), or
 * reported a failure after the snooze was set. A completion is not a raised hand: a long-running
 * task would otherwise wake itself on every turn and the snooze would do nothing.
 */
export function snoozeRaisedHand(
  task: Pick<Task, "snoozedAt">,
  sessions: readonly Session[],
): boolean {
  for (const session of sessions) {
    const status = sessionStatus(session);
    if (status === undefined) continue;
    if (status.state === "blocked") return true;
    if (status.state === "error" && (task.snoozedAt === null || status.updatedAt > task.snoozedAt))
      return true;
  }
  return false;
}

/**
 * Whether a task stays off the active list. Derived on every read, never written: the stored wake
 * time is the only fact, so an expired or interrupted snooze needs no cleanup.
 */
export function isTaskSnoozed(
  task: Pick<Task, "snoozedUntil" | "snoozedAt">,
  sessions: readonly Session[],
  now: number,
): boolean {
  if (task.snoozedUntil === null || task.snoozedUntil <= now) return false;
  return !snoozeRaisedHand(task, sessions);
}

/** Whether the row menu may offer a snooze: the server refuses the same case, a waiting agent. */
export function canSnoozeTask(sessions: readonly Session[]): boolean {
  return !sessions.some((session) => sessionStatus(session)?.state === "blocked");
}

/** Whether the next wake instant is in the future, for a clock that re-reads the list exactly then. */
export function nextSnoozeWake(
  tasks: readonly Pick<Task, "snoozedUntil">[],
  now: number,
): number | null {
  let next: number | null = null;
  for (const task of tasks) {
    if (task.snoozedUntil === null || task.snoozedUntil <= now) continue;
    if (next === null || task.snoozedUntil < next) next = task.snoozedUntil;
  }
  return next;
}

/**
 * When a snooze ended, if it has ended: the moment an agent raised its hand, else the scheduled
 * wake. `null` while the snooze still runs, and for a task that was never snoozed.
 */
export function snoozeWokeAt(
  task: Pick<Task, "snoozedUntil" | "snoozedAt" | "state">,
  sessions: readonly Session[],
  now: number,
): number | null {
  if (task.snoozedUntil === null || task.state === "settled") return null;
  // Once the scheduled time is here the snooze ended by the clock; a failure that arrives later is
  // an ordinary unseen status, not a hand that ended a still-running snooze.
  if (task.snoozedUntil <= now) return task.snoozedUntil;
  let raisedAt: number | null = null;
  for (const session of sessions) {
    const status = sessionStatus(session);
    if (status === undefined) continue;
    const failed =
      status.state === "error" && (task.snoozedAt === null || status.updatedAt > task.snoozedAt);
    if (status.state !== "blocked" && !failed) continue;
    if (raisedAt === null || status.updatedAt < raisedAt) raisedAt = status.updatedAt;
  }
  return raisedAt;
}

/**
 * Whether a row should say `Woke`: its snooze ended after the last time the user looked at the
 * task. `seenAt` is the server's record of that look, stamped by a visit and by a dismissal.
 */
export function isSnoozeWokeUnseen(
  task: Pick<Task, "snoozedUntil" | "snoozedAt" | "state" | "seenAt">,
  sessions: readonly Session[],
  now: number,
): boolean {
  const wokeAt = snoozeWokeAt(task, sessions, now);
  return wokeAt !== null && (task.seenAt === null || wokeAt > task.seenAt);
}

/** `12m`, `3h`, `2d`: what a snoozed row says in place of its status. */
export function snoozeWakeLabel(until: number, now: number): string {
  const remaining = until - now;
  if (!Number.isFinite(remaining) || remaining <= 0) return "now";
  if (remaining < HOUR_MS) return `${Math.max(1, Math.ceil(remaining / MINUTE_MS))}m`;
  if (remaining < DAY_MS) return `${Math.ceil(remaining / HOUR_MS)}h`;
  return `${Math.ceil(remaining / DAY_MS)}d`;
}

/** A clock time in the reader's locale: `19:42` where that is the habit, `7:42 PM` where it is not. */
export function snoozeClockLabel(at: Date): string {
  return at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** One menu choice, as resolved for this moment. */
export interface SnoozeChoice {
  id: string;
  /** `In 1 hour`, `This evening`, `Tomorrow`, `Next week`. */
  label: string;
  /** The wake time: a clock time, with a weekday when the label does not already name the day. */
  when: string;
  until: number;
}

const WEEKDAY_INDEX: Readonly<Record<SnoozePresetDay, number>> = {
  today: 0,
  tomorrow: 0,
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

// Calendar-day advance rather than adding DAY_MS: a spring-forward day is 23 hours, so 23:30 plus
// a fixed day would skip the whole next day.
function addSnoozeDays(base: Date, days: number): Date {
  const next = new Date(base.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** The largest unit that divides evenly: `3 hours`, `90 minutes`, `2 days`. */
function formatSnoozeDuration(minutes: number): string {
  if (minutes % (24 * 60) === 0) return plural(minutes / (24 * 60), "day");
  if (minutes % 60 === 0) return plural(minutes / 60, "hour");
  return plural(minutes, "minute");
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function daysAhead(setting: Extract<SnoozePreset, { kind: "at" }>, now: Date): number {
  if (setting.day === "today") return 0;
  if (setting.day === "tomorrow") return 1;
  return (WEEKDAY_INDEX[setting.day] - now.getDay() + 7) % 7 || 7;
}

/** Labels follow the actual day gap, so Monday's preset on a Sunday reads `Tomorrow`. */
function presetLabel(setting: SnoozePreset, ahead: number): string {
  if (setting.kind === "after") return `In ${formatSnoozeDuration(setting.minutes)}`;
  if (ahead === 0) {
    const hour = Number(setting.time.slice(0, 2));
    return hour < 12 ? "This morning" : hour < 17 ? "This afternoon" : "This evening";
  }
  if (ahead === 1) return "Tomorrow";
  if (setting.day === "monday") return "Next week";
  return ahead === 7 ? `Next ${capitalize(setting.day)}` : capitalize(setting.day);
}

export function snoozeChoiceId(setting: SnoozePreset): string {
  return setting.kind === "after"
    ? `after:${setting.minutes}`
    : `at:${setting.day}:${setting.time}`;
}

/** One preset at this moment, or nothing when a local time has already passed today. */
export function resolveSnoozeChoice(
  setting: SnoozePreset,
  now: Date,
  formatTime: (at: Date) => string = snoozeClockLabel,
): SnoozeChoice | null {
  let wake: Date;
  let ahead = 0;
  if (setting.kind === "after") {
    wake = new Date(now.getTime() + setting.minutes * MINUTE_MS);
  } else {
    ahead = daysAhead(setting, now);
    wake = addSnoozeDays(now, ahead);
    wake.setHours(Number(setting.time.slice(0, 2)), Number(setting.time.slice(3)), 0, 0);
    if (wake.getTime() <= now.getTime()) return null;
  }
  const label = presetLabel(setting, ahead);
  // A duration and "Next week" do not name the wake day, so a wake on another day shows it.
  const namesDay = setting.kind === "at" && label !== "Next week";
  const time = formatTime(wake);
  return {
    id: snoozeChoiceId(setting),
    label,
    when:
      namesDay || wake.toDateString() === now.toDateString()
        ? time
        : `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`,
    until: wake.getTime(),
  };
}

/** The menu, soonest first, one row per wake minute. */
export function resolveSnoozeChoices(
  presets: readonly SnoozePreset[],
  now: Date,
  formatTime: (at: Date) => string = snoozeClockLabel,
): SnoozeChoice[] {
  const seen = new Set<number>();
  return presets
    .flatMap((setting) => {
      const choice = resolveSnoozeChoice(setting, now, formatTime);
      return choice === null ? [] : [choice];
    })
    .toSorted((a, b) => a.until - b.until)
    .filter((choice) => {
      // By minute: a duration keeps the clock's seconds, so the same minute is the same choice.
      const minute = Math.floor(choice.until / MINUTE_MS);
      if (seen.has(minute)) return false;
      seen.add(minute);
      return true;
    });
}

/**
 * A menu choice as picked. A duration re-resolves from its setting, so it starts at selection; a
 * set time keeps the instant that was shown, which a day change would otherwise shift.
 */
export function pickSnoozeChoice(input: {
  shown: readonly SnoozeChoice[];
  presets: readonly SnoozePreset[];
  id: string;
  now: Date;
  formatTime?: (at: Date) => string;
}): number | null {
  const setting = input.presets.find(
    (candidate) => candidate.kind === "after" && snoozeChoiceId(candidate) === input.id,
  );
  if (setting !== undefined) {
    const fresh = resolveSnoozeChoice(setting, input.now, input.formatTime);
    return fresh === null ? null : fresh.until;
  }
  const shown = input.shown.find((choice) => choice.id === input.id);
  // A set time that has passed since the menu opened would leave the row in the list at once.
  return shown !== undefined && shown.until > input.now.getTime() ? shown.until : null;
}

export type CustomSnoozeInput =
  | { mode: "date"; date: string; time: string }
  | { mode: "duration"; amount: string; unit: "minutes" | "hours" | "days" };

export function localSnoozeDate(at: Date): string {
  return `${String(at.getFullYear()).padStart(4, "0")}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
}

export function localSnoozeTime(at: Date): string {
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

/**
 * The instant a custom snooze wakes at, or `null` for a time the dialog must refuse: in the past,
 * further than 30 days, rolled over (`2026-02-30`) or nonexistent locally across a DST change.
 */
export function customSnoozeUntil(input: CustomSnoozeInput, now: Date): number | null {
  let wake: Date;
  if (input.mode === "duration") {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000) return null;
    const unitMs = { minutes: MINUTE_MS, hours: HOUR_MS, days: DAY_MS }[input.unit];
    wake = new Date(now.getTime() + amount * unitMs);
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{2}:\d{2}$/.test(input.time)) return null;
    wake = new Date(`${input.date}T${input.time}:00`);
    if (localSnoozeDate(wake) !== input.date || localSnoozeTime(wake) !== input.time) return null;
  }
  const until = wake.getTime();
  if (!Number.isFinite(until) || until <= now.getTime()) return null;
  return until - now.getTime() <= MAX_SNOOZE_MS ? until : null;
}
