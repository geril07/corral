import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

/**
 * One schema step: SQL, or a function for a step that must look before it writes (`ALTER TABLE`
 * has no `IF NOT EXISTS`, and a development database can already be shaped like the target).
 */
export type Migration = string | ((db: DatabaseSync) => void);

/** The current fresh database schema. Older schemas are not upgraded by this rebuild. */
export const MIGRATIONS: readonly Migration[] = [
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
     default_base_branch TEXT NOT NULL, pinned_at INTEGER
   ) STRICT;
   CREATE TABLE tasks (
     id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
     title TEXT NOT NULL, title_source TEXT NOT NULL DEFAULT 'user', source TEXT, prompt TEXT,
     primary_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
     branch TEXT, workspace_path TEXT NOT NULL, owns_worktree INTEGER NOT NULL,
     state TEXT NOT NULL, seen_at INTEGER, created_at INTEGER NOT NULL
   ) STRICT;
   CREATE INDEX tasks_by_project ON tasks(project_id);
   CREATE TABLE sessions (
     id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     kind TEXT NOT NULL, agent_session_id TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL,
     label TEXT, launch_spec TEXT,
     view TEXT NOT NULL DEFAULT 'terminal'
   ) STRICT;
   CREATE INDEX sessions_by_task ON sessions(task_id);
   CREATE TABLE session_launch_specs (
     session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
     spec TEXT NOT NULL
   ) STRICT;
   CREATE TABLE pull_requests (
     task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
     provider TEXT NOT NULL, host TEXT NOT NULL, number INTEGER NOT NULL, url TEXT NOT NULL,
     title TEXT NOT NULL, branch TEXT, base TEXT, state TEXT NOT NULL, state_reason TEXT,
     checks TEXT, fetched_at INTEGER, repository TEXT
   ) STRICT;`,
  // A development database can already carry the columns, so each step looks before it writes.
  (db) => {
    if (!tableHasColumn(db, "tasks", "snoozed_until"))
      db.exec("ALTER TABLE tasks ADD COLUMN snoozed_until INTEGER");
    if (!tableHasColumn(db, "tasks", "snoozed_at"))
      db.exec("ALTER TABLE tasks ADD COLUMN snoozed_at INTEGER");
  },
  // A chat's own choices are server state, not part of the immutable launch snapshot: the snapshot
  // says how the conversation was opened, these rows say what its next turn should run and what is
  // queued for it. The queue outlives a client and a server crash; its status, not a client's
  // optimism, decides whether it may be sent again.
  `CREATE TABLE IF NOT EXISTS chat_session_selections (
     session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
     selection TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   ) STRICT;
   CREATE TABLE IF NOT EXISTS chat_thinking_memory (
     scope TEXT NOT NULL,
     model TEXT NOT NULL,
     level TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (scope, model)
   ) STRICT;
   CREATE TABLE IF NOT EXISTS chat_queue (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
     text TEXT NOT NULL,
     selection TEXT,
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL
   ) STRICT;
   CREATE INDEX IF NOT EXISTS chat_queue_by_session ON chat_queue(session_id);`,
];

/** Whether `table` already has `column`; the guard a conditional schema step writes. */
export function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => row["name"] === column);
}

export const DATABASE_FILE = "corral.db";

/** Opens `<dataDir>/corral.db`, creating the directory and bringing the schema up to date. */
export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, DATABASE_FILE));
  try {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    migrate(db, MIGRATIONS);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function migrate(db: DatabaseSync, migrations: readonly Migration[]): void {
  const applied = schemaVersion(db);
  if (applied > migrations.length)
    throw new Error(
      `database schema version ${applied} is newer than this server knows (${migrations.length})`,
    );
  for (let version = applied; version < migrations.length; version++) {
    db.exec("BEGIN");
    try {
      const step = migrations[version]!;
      if (typeof step === "string") db.exec(step);
      else step(db);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  return Number(row?.["user_version"] ?? 0);
}
