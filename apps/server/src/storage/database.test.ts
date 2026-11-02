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

test("migrating a database from before settling turns archived tasks into settled ones and keeps their sessions", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, 2));
  db.exec(`
    INSERT INTO projects (id, name, path, default_base_branch) VALUES ('p', 'n', '/n', 'main');
    INSERT INTO tasks (id, project_id, title, branch, workspace_path, owns_worktree, state, created_at)
      VALUES ('old', 'p', 'old', 'b', '/n', 0, 'archived', 1), ('new', 'p', 'new', 'b', '/n', 0, 'active', 2);
    INSERT INTO sessions (id, task_id, kind, agent_session_id, state, created_at)
      VALUES ('s', 'old', 'shell', NULL, 'running', 3);
  `);

  migrate(db, MIGRATIONS);

  expect(db.prepare("SELECT id, state FROM tasks ORDER BY created_at").all()).toEqual([
    { id: "old", state: "settled" },
    { id: "new", state: "active" },
  ]);
  expect(db.prepare("SELECT id, state, resume_on_unsettle FROM sessions").all()).toEqual([
    { id: "s", state: "running", resume_on_unsettle: 0 },
  ]);
});

test("migrating a database from before labels keeps its sessions, unlabelled", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, 3));
  db.exec(`
    INSERT INTO projects (id, name, path, default_base_branch) VALUES ('p', 'n', '/n', 'main');
    INSERT INTO tasks (id, project_id, title, branch, workspace_path, owns_worktree, state, created_at)
      VALUES ('t', 'p', 'task', 'b', '/n', 0, 'active', 1);
    INSERT INTO sessions (id, task_id, kind, agent_session_id, state, created_at)
      VALUES ('s', 't', 'shell', NULL, 'running', 2);
  `);

  migrate(db, MIGRATIONS);

  expect(db.prepare("SELECT id, label FROM sessions").all()).toEqual([{ id: "s", label: null }]);
  db.close();
});

test("a session from before launch profiles keeps its old launch behavior", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, 3));
  db.exec(`
    INSERT INTO projects (id, name, path, default_base_branch) VALUES ('p', 'n', '/n', 'main');
    INSERT INTO tasks (id, project_id, title, branch, workspace_path, owns_worktree, state, created_at)
      VALUES ('t', 'p', 'task', 'b', '/n', 0, 'active', 1);
    INSERT INTO sessions (id, task_id, kind, agent_session_id, state, created_at)
      VALUES ('s', 't', 'claude', 'old-session', 'stopped', 2);
  `);

  migrate(db, MIGRATIONS);

  expect(db.prepare("SELECT launch_spec FROM sessions WHERE id = 's'").get()).toEqual({
    launch_spec: null,
  });
  expect(new SessionStore(db).get("s")).toMatchObject({
    id: "s",
    kind: "claude",
    agentSessionId: "old-session",
    launch: null,
  });
  db.close();
});

test("migrating a labelled database adds the task source without touching labels", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, 4));
  db.exec(`
    INSERT INTO projects (id, name, path, default_base_branch) VALUES ('p', 'n', '/n', 'main');
    INSERT INTO tasks (id, project_id, title, branch, workspace_path, owns_worktree, state, created_at)
      VALUES ('t', 'p', 'task', 'b', '/n', 0, 'active', 1);
    INSERT INTO sessions (id, task_id, kind, agent_session_id, state, label, created_at)
      VALUES ('s', 't', 'shell', NULL, 'running', 'my shell', 2);
  `);

  migrate(db, MIGRATIONS);

  expect(schemaVersion(db)).toBe(MIGRATIONS.length);
  expect(db.prepare("SELECT id, label FROM sessions").all()).toEqual([
    { id: "s", label: "my shell" },
  ]);
  expect(db.prepare("SELECT id, source FROM tasks").all()).toEqual([{ id: "t", source: null }]);
});

test("migrating a database from before title sources makes every existing title the user's", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  // Every migration before the title source; it and the two later ones are left out.
  migrate(db, MIGRATIONS.slice(0, MIGRATIONS.length - 3));
  db.exec(`
    INSERT INTO projects (id, name, path, default_base_branch) VALUES ('p', 'n', '/n', 'main');
    INSERT INTO tasks (id, project_id, title, branch, workspace_path, owns_worktree, state, created_at)
      VALUES ('t', 'p', 'typed by hand', 'b', '/n', 0, 'active', 1);
  `);

  migrate(db, MIGRATIONS);

  expect(db.prepare("SELECT title, title_source, seen_at FROM tasks").all()).toEqual([
    { title: "typed by hand", title_source: "user", seen_at: null },
  ]);
  db.close();
});

test("migrating a database from before seenAt leaves its tasks unread", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  // The title source is there; the seen-at column and the prompt migration are not.
  migrate(db, MIGRATIONS.slice(0, MIGRATIONS.length - 2));
  db.exec(`
    INSERT INTO projects (id, name, path, default_base_branch) VALUES ('p', 'n', '/n', 'main');
    INSERT INTO tasks (id, project_id, title, title_source, branch, workspace_path, owns_worktree, state, created_at)
      VALUES ('t', 'p', 'already there', 'user', 'b', '/n', 0, 'active', 1);
  `);

  migrate(db, MIGRATIONS);

  expect(db.prepare("SELECT id, seen_at FROM tasks").all()).toEqual([{ id: "t", seen_at: null }]);
  db.close();
});

test("migrating a database from before task prompts adds both columns empty and keeps the tasks", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, MIGRATIONS.length - 1));
  db.exec(`
    INSERT INTO projects (id, name, path, default_base_branch) VALUES ('p', 'n', '/n', 'main');
    INSERT INTO tasks (id, project_id, title, branch, workspace_path, owns_worktree, state, created_at)
      VALUES ('t', 'p', 'typed by hand', 'b', '/n', 0, 'active', 1);
    INSERT INTO sessions (id, task_id, kind, agent_session_id, state, created_at)
      VALUES ('s', 't', 'shell', NULL, 'running', 2);
  `);

  migrate(db, MIGRATIONS);

  expect(db.prepare("SELECT id, prompt, primary_session_id FROM tasks").all()).toEqual([
    { id: "t", prompt: null, primary_session_id: null },
  ]);
  expect(new TaskStore(db).get("t")).toMatchObject({ prompt: null, primarySessionId: null });
  db.close();
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

test("migrating a database from before chat keeps every existing session in a terminal", () => {
  const db = new DatabaseSync(":memory:");
  // Every migration but the view column, which is the one this test is about.
  migrate(db, MIGRATIONS.slice(0, MIGRATIONS.length - 1));
  db.exec(
    `INSERT INTO projects (id, name, path, default_base_branch) VALUES ('p', 'n', '/n', 'main');
     INSERT INTO tasks (id, project_id, title, branch, workspace_path, owns_worktree, state, created_at)
       VALUES ('t', 'p', 'title', 'branch', '/work/t', 0, 'active', 1);
     INSERT INTO sessions (id, task_id, kind, agent_session_id, state, created_at)
       VALUES ('s', 't', 'claude', 'conversation', 'running', 2);`,
  );

  migrate(db, MIGRATIONS);

  expect(schemaVersion(db)).toBe(MIGRATIONS.length);
  expect(new SessionStore(db).get("s")).toMatchObject({ id: "s", view: "terminal" });
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

test("a database already at version 11 gains the request's repository column", () => {
  // The table was created without `repository`; editing migration 11 in place would never run its
  // CREATE again, so the column arrives as migration 12 and an existing row keeps its link.
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db, MIGRATIONS.slice(0, MIGRATIONS.length - 1));
  db.exec(`
    INSERT INTO projects (id, name, path, default_base_branch) VALUES ('p', 'n', '/n', 'main');
    INSERT INTO tasks (id, project_id, title, branch, workspace_path, owns_worktree, state, created_at)
      VALUES ('t', 'p', 'task', 'b', '/n', 0, 'active', 1);
    INSERT INTO pull_requests (task_id, provider, host, number, url, title, branch, base, state, state_reason, checks, fetched_at)
      VALUES ('t', 'github', 'forge.example', 7, 'https://forge.example/acme/app/pull/7', 'Ship', 'b', 'main', 'open', NULL, NULL, 1);
  `);

  migrate(db, MIGRATIONS);

  expect(schemaVersion(db)).toBe(MIGRATIONS.length);
  expect(db.prepare("SELECT task_id, repository FROM pull_requests").all()).toEqual([
    { task_id: "t", repository: null },
  ]);
  db.close();
});
