import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import type { Task } from "@corral/protocol/rpc";
import { SessionStore } from "../sessions/session-store.ts";
import { TaskStore } from "../tasks/task-store.ts";
import { MIGRATIONS, migrate, openDatabase, schemaVersion } from "./database.ts";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "corral-db-"));
});
afterEach(() => rm(dataDir, { recursive: true, force: true }));

test("a new database gets every migration and survives being opened again with its data", () => {
  const first = openDatabase(join(dataDir, "nested", "data"));
  expect(schemaVersion(first)).toBe(MIGRATIONS.length);
  first.exec(
    "INSERT INTO projects (id, name, path, default_base_branch) VALUES ('p', 'n', '/n', 'main')",
  );
  first.close();

  const second = openDatabase(join(dataDir, "nested", "data"));
  expect(second.prepare("SELECT id FROM projects").all()).toEqual([{ id: "p" }]);
  expect(schemaVersion(second)).toBe(MIGRATIONS.length);
  second.close();
});

test("only the migrations not yet applied run", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, ["CREATE TABLE a (x)"]);
  migrate(db, ["CREATE TABLE a (x)", "CREATE TABLE b (y)"]);

  expect(schemaVersion(db)).toBe(2);
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE name IN ('a','b') ORDER BY name").all(),
  ).toEqual([{ name: "a" }, { name: "b" }]);
});

test("a failing migration changes nothing and leaves the version where it was", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, ["CREATE TABLE a (x)"]);

  expect(() =>
    migrate(db, ["CREATE TABLE a (x)", "CREATE TABLE b (y); INSERT INTO missing VALUES (1)"]),
  ).toThrow(/no such table/);

  expect(schemaVersion(db)).toBe(1);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").all()).toEqual([]);
});

test("a database from a newer server is refused", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);

  expect(() => migrate(db, MIGRATIONS)).toThrow(/newer/);
});

test("the task insert writes the primary session instead of dropping it", () => {
  const db = openDatabase(dataDir);
  db.exec(
    "INSERT INTO projects (id, name, path, default_base_branch) VALUES ('p', 'n', '/n', 'main')",
  );
  const tasks = new TaskStore(db);
  const sessions = new SessionStore(db);
  // A caller holding both ids writes the two rows together, so the foreign key is checked at
  // commit. Task creation cannot use this order — it learns the session id only after the launch —
  // and writes the column again with `setPrimarySession`; the insert must not lose it either way.
  db.exec("BEGIN; PRAGMA defer_foreign_keys = ON;");
  sessions.insert({
    id: "primary",
    taskId: "a",
    kind: "claude",
    view: "terminal",
    agentSessionId: "conversation",
    state: "running",
    label: null,
    createdAt: 2,
    launch: null,
  });
  tasks.insert({ ...storedTask("a", "seed"), primarySessionId: "primary" });
  db.exec("COMMIT");

  expect(tasks.get("a")).toMatchObject({ primarySessionId: "primary" });
  db.close();
});

test("a task's primary session reference goes away with that session, not with the task", () => {
  const db = openDatabase(dataDir);
  db.exec(
    "INSERT INTO projects (id, name, path, default_base_branch) VALUES ('p', 'n', '/n', 'main')",
  );
  const tasks = new TaskStore(db);
  const sessions = new SessionStore(db);
  tasks.insert(storedTask("a", "seed"));
  sessions.insert({
    id: "primary",
    taskId: "a",
    kind: "claude",
    view: "terminal",
    agentSessionId: "conversation",
    state: "running",
    label: null,
    createdAt: 2,
    launch: null,
  });
  tasks.setPrimarySession("a", "primary");
  expect(tasks.get("a")).toMatchObject({ primarySessionId: "primary" });

  sessions.delete("primary");

  expect(tasks.get("a")).toMatchObject({ primarySessionId: null });

  // Removing the task takes its remaining sessions along; the reference never points at nothing.
  sessions.insert({
    id: "other",
    taskId: "a",
    kind: "claude",
    view: "terminal",
    agentSessionId: "conversation-2",
    state: "stopped",
    label: null,
    createdAt: 3,
    launch: null,
  });
  tasks.setPrimarySession("a", "other");
  tasks.delete("a");

  expect(sessions.list()).toEqual([]);
  db.close();
});

const storedTask = (id: string, titleSource: Task["titleSource"]): Task => ({
  id,
  projectId: "p",
  title: `${titleSource} title`,
  titleSource,
  prompt: null,
  primarySessionId: null,
  branch: `branch-${id}`,
  workspacePath: `/work/${id}`,
  ownsWorktree: false,
  state: "active",
  seenAt: null,
  createdAt: 1,
});

test("the task store keeps where a title came from, and a rename stores the user's title", () => {
  const db = openDatabase(dataDir);
  db.exec(
    "INSERT INTO projects (id, name, path, default_base_branch) VALUES ('p', 'n', '/n', 'main')",
  );
  const store = new TaskStore(db);
  store.insert(storedTask("a", "seed"));
  store.insert(storedTask("b", "user"));

  expect(store.get("a")).toEqual(storedTask("a", "seed"));
  expect(store.list().map((task) => task.titleSource)).toEqual(["seed", "user"]);

  store.rename("a", "My own name");

  expect(store.get("a")).toEqual({
    ...storedTask("a", "user"),
    title: "My own name",
  });
  expect(store.get("b")).toEqual(storedTask("b", "user"));
  db.close();
});

test("the session store writes the view of a chat session and reads it back", () => {
  const db = openDatabase(dataDir);
  db.exec(
    `INSERT INTO projects (id, name, path, default_base_branch) VALUES ('p', 'n', '/n', 'main');
     INSERT INTO tasks (id, project_id, title, branch, workspace_path, owns_worktree, state, created_at)
       VALUES ('t', 'p', 'title', 'branch', '/work/t', 0, 'active', 1);`,
  );
  const sessions = new SessionStore(db);
  sessions.insert({
    id: "s",
    taskId: "t",
    kind: "pi",
    view: "chat",
    agentSessionId: "agent-session",
    state: "running",
    label: null,
    createdAt: 2,
    launch: null,
  });

  expect(sessions.get("s")).toMatchObject({ id: "s", view: "chat", kind: "pi" });
  db.close();
});

test("private launch data is stored beside the session, never in its public columns, and goes with it", () => {
  const db = openDatabase(dataDir);
  db.exec(
    `INSERT INTO projects (id, name, path, default_base_branch) VALUES ('p', 'n', '/n', 'main');
     INSERT INTO tasks (id, project_id, title, branch, workspace_path, owns_worktree, state, created_at)
       VALUES ('t', 'p', 'title', 'branch', '/work/t', 0, 'active', 1);`,
  );
  const sessions = new SessionStore(db);
  const spec = {
    instanceId: "one",
    command: "/opt/pi",
    args: ["--no-skills"],
    literalEnv: [{ targetName: "TOKEN", value: "sk-private-db-sentinel" }],
  };
  sessions.insert(
    {
      id: "s",
      taskId: "t",
      kind: "pi",
      view: "terminal",
      agentSessionId: "agent-session",
      state: "running",
      label: null,
      createdAt: 2,
      launch: null,
    },
    spec,
  );

  expect(sessions.privateLaunch("s")).toEqual(spec);
  expect(JSON.stringify(sessions.get("s"))).not.toContain("sk-private-db-sentinel");
  expect(JSON.stringify(db.prepare("SELECT * FROM sessions").all())).not.toContain(
    "sk-private-db-sentinel",
  );

  sessions.delete("s");
  expect(sessions.privateLaunch("s")).toBeUndefined();
  db.close();
});
