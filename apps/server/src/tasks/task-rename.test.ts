import type { Task } from "@corral/protocol/rpc";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { disabledNaming } from "../naming/naming.ts";
import { ProjectStore } from "../projects/project-store.ts";
import { openDatabase } from "../storage/database.ts";
import { BlankTaskTitleError, TaskNotFoundError } from "./errors.ts";
import { TaskService, type TaskSessions } from "./task-service.ts";
import { defaultTaskSettings } from "./task-settings.ts";
import { TaskStore } from "./task-store.ts";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "corral-rename-"));
});
afterEach(() => rm(dataDir, { recursive: true, force: true }));

const storedTask = (id: string): Task => ({
  id,
  projectId: "p",
  title: "typed by hand",
  titleSource: "user",
  prompt: null,
  primarySessionId: null,
  branch: "branch",
  workspacePath: `/work/${id}`,
  ownsWorktree: false,
  state: "active",
  seenAt: null,
  createdAt: 1,
});

/** A task's real store on a temp database, with the sessions boundary under the test's control. */
function serviceWith(sessions: TaskSessions) {
  const db = openDatabase(dataDir);
  const projects = new ProjectStore(db);
  projects.insert({ id: "p", name: "n", path: dataDir, defaultBaseBranch: "main" });
  const store = new TaskStore(db);
  store.insert(storedTask("t"));
  const settings = defaultTaskSettings({ dataDir });
  return {
    tasks: new TaskService({ store, projects, sessions, settings, naming: disabledNaming() }),
    store,
    db,
  };
}

test("a rename queued behind a removal waits for it and fails without writing the removed task", async () => {
  let removalStarted!: () => void;
  const started = new Promise<void>((resolve) => (removalStarted = resolve));
  let finishRemoval!: () => void;
  const stopping = new Promise<void>((resolve) => (finishRemoval = resolve));
  const sessions: TaskSessions = {
    hasRunningIn: () => false,
    removeAllIn: () => {
      removalStarted();
      return stopping;
    },
    suspendAllIn: () => Promise.resolve(),
    resumeAllIn: () => Promise.resolve(),
    startPrimary: () => {
      throw new Error("a rename starts no session");
    },
  };
  const { tasks, store, db } = serviceWith(sessions);

  const removal = tasks.remove("t", true);
  await started;
  const rename = tasks.rename("t", "My own name");
  // The removal is still stopping its sessions, and the queued rename has not touched the title.
  expect(store.get("t")).toEqual(storedTask("t"));

  finishRemoval();
  await removal;

  await expect(rename).rejects.toBeInstanceOf(TaskNotFoundError);
  expect(store.get("t")).toBeUndefined();
  db.close();
});

test("a blank title is refused before anything is written, so the task list still reads", async () => {
  const sessions: TaskSessions = {
    hasRunningIn: () => false,
    removeAllIn: () => Promise.resolve(),
    suspendAllIn: () => Promise.resolve(),
    resumeAllIn: () => Promise.resolve(),
    startPrimary: () => {
      throw new Error("a rename starts no session");
    },
  };
  const { tasks, store, db } = serviceWith(sessions);

  await expect(tasks.rename("t", "   ")).rejects.toBeInstanceOf(BlankTaskTitleError);

  // An empty title written to the row would make every later read fail the task schema.
  expect(store.list()).toEqual([storedTask("t")]);
  db.close();
});

test("a rename that runs before a removal applies, and the removal then takes the task away", async () => {
  const sessions: TaskSessions = {
    hasRunningIn: () => false,
    removeAllIn: () => Promise.resolve(),
    suspendAllIn: () => Promise.resolve(),
    resumeAllIn: () => Promise.resolve(),
    startPrimary: () => {
      throw new Error("a rename starts no session");
    },
  };
  const { tasks, store, db } = serviceWith(sessions);

  expect(await tasks.rename("t", "  My own name  ")).toEqual({
    ...storedTask("t"),
    title: "My own name",
  });
  expect(store.get("t")).toEqual({ ...storedTask("t"), title: "My own name" });

  await tasks.remove("t", true);

  expect(store.get("t")).toBeUndefined();
  db.close();
});
