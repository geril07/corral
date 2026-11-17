import type { Task } from "@corral/protocol/rpc";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { disabledNaming } from "../naming/naming.ts";
import { ProjectStore } from "../projects/project-store.ts";
import { openDatabase } from "../storage/database.ts";
import { SettledTaskSnoozeError, SnoozeTimeError, TaskNeedsUserError } from "./errors.ts";
import { TaskService, type TaskSessions } from "./task-service.ts";
import { defaultTaskSettings } from "./task-settings.ts";
import { TaskStore } from "./task-store.ts";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "corral-snooze-"));
});
afterEach(() => rm(dataDir, { recursive: true, force: true }));

const storedTask = (id: string): Task => ({
  id,
  projectId: "p",
  title: "Waiting",
  titleSource: "user",
  prompt: null,
  primarySessionId: null,
  branch: "branch",
  workspacePath: `/work/${id}`,
  ownsWorktree: false,
  state: "active",
  seenAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  createdAt: 1,
});

/** A task's real store on a temp database, with the sessions boundary under the test's control. */
function serviceWith(sessions: Partial<TaskSessions> = {}) {
  const db = openDatabase(dataDir);
  const projects = new ProjectStore(db);
  projects.insert({ id: "p", name: "n", path: dataDir, defaultBaseBranch: "main", pinnedAt: null });
  const store = new TaskStore(db);
  store.insert(storedTask("t"));
  const tasks = new TaskService({
    dataDir,
    store,
    projects,
    sessions: {
      hasRunningIn: () => false,
      blockedIn: () => false,
      removeAllIn: () => Promise.resolve(),
      closeTerminalsIn: () => Promise.resolve(),
      startPrimary: () => {
        throw new Error("a snooze starts no session");
      },
      hasChatDriver: () => false,
      ...sessions,
    },
    settings: defaultTaskSettings({ dataDir }),
    naming: disabledNaming(),
  });
  return { tasks, store, db };
}

const HOUR = 60 * 60 * 1000;

test("snoozing writes both fields and nothing else; unsnoozing clears them", async () => {
  const { tasks, store, db } = serviceWith();
  const until = Date.now() + HOUR;

  const snoozed = await tasks.snooze("t", until);

  expect(snoozed.snoozedUntil).toBe(until);
  expect(snoozed.snoozedAt).toBeGreaterThan(0);
  // The snooze is an overlay: the task keeps its state, and the row keeps every other field.
  expect({ ...snoozed, snoozedUntil: 0, snoozedAt: 0 }).toEqual({
    ...storedTask("t"),
    snoozedUntil: 0,
    snoozedAt: 0,
  });
  expect(store.get("t")).toEqual(snoozed);

  const awake = await tasks.unsnooze("t");

  expect(awake).toEqual(storedTask("t"));
  expect(store.get("t")).toEqual(storedTask("t"));
  db.close();
});

test("unsnoozing a task that is not snoozed is a no-op", async () => {
  const { tasks, store, db } = serviceWith();
  const before = store.get("t");

  expect(await tasks.unsnooze("t")).toEqual(before);
  expect(store.get("t")).toEqual(before);
  db.close();
});

test("a wake time that is not in the future is refused and writes nothing", async () => {
  const { tasks, store, db } = serviceWith();

  await expect(tasks.snooze("t", Date.now() - 1)).rejects.toBeInstanceOf(SnoozeTimeError);
  await expect(tasks.snooze("t", Number.NaN)).rejects.toBeInstanceOf(SnoozeTimeError);

  expect(store.get("t")).toEqual(storedTask("t"));
  db.close();
});

test("a task whose agent waits on the user is refused, and a working one is not", async () => {
  let blocked = true;
  const { tasks, store, db } = serviceWith({ blockedIn: () => blocked });

  await expect(tasks.snooze("t", Date.now() + HOUR)).rejects.toBeInstanceOf(TaskNeedsUserError);
  expect(store.get("t")).toEqual(storedTask("t"));

  blocked = false;
  expect((await tasks.snooze("t", Date.now() + HOUR)).snoozedUntil).toBeGreaterThan(0);
  db.close();
});

test("settling a snoozed task clears the snooze, so two hidden states cannot disagree", async () => {
  const { tasks, db } = serviceWith();
  await tasks.snooze("t", Date.now() + HOUR);

  const settled = await tasks.setState("t", "settled");

  expect(settled).toEqual({ ...storedTask("t"), state: "settled" });
  // Un-settling brings the task back active; the snooze is not revived.
  expect(await tasks.setState("t", "active")).toEqual(storedTask("t"));
  db.close();
});

test("new work in a snoozed task wakes it", async () => {
  const { tasks, store, db } = serviceWith();
  await tasks.snooze("t", Date.now() + HOUR);

  tasks.taskActivated("t");

  expect(store.get("t")).toEqual(storedTask("t"));
  db.close();
});

test("a settled task is refused, because the shelf already hides it", async () => {
  const { tasks, store, db } = serviceWith();
  await tasks.setState("t", "settled");

  await expect(tasks.snooze("t", Date.now() + HOUR)).rejects.toBeInstanceOf(SettledTaskSnoozeError);
  expect(store.get("t")).toEqual({ ...storedTask("t"), state: "settled" });
  db.close();
});
