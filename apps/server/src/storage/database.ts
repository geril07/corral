import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

/** Schema changes, oldest first. `PRAGMA user_version` counts the ones applied; never edit one that shipped. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     path TEXT NOT NULL UNIQUE,
     default_base_branch TEXT NOT NULL
   ) STRICT;
   CREATE TABLE tasks (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     branch TEXT NOT NULL,
     workspace_path TEXT NOT NULL,
     owns_worktree INTEGER NOT NULL,
     state TEXT NOT NULL,
     created_at INTEGER NOT NULL
   ) STRICT;
   CREATE INDEX tasks_by_project ON tasks(project_id);`,
  `CREATE TABLE sessions (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     agent_session_id TEXT,
     state TEXT NOT NULL,
     created_at INTEGER NOT NULL
   ) STRICT;
   CREATE INDEX sessions_by_task ON sessions(task_id);`,
  `UPDATE tasks SET state = 'settled' WHERE state = 'archived';
   ALTER TABLE sessions ADD COLUMN resume_on_unsettle INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE sessions ADD COLUMN label TEXT;`,
  // Nonsecret launch choices (model/provider/profile revision/env reference names) as JSON.
  // Stored once at start; a later config edit never rewrites it.
  `ALTER TABLE sessions ADD COLUMN launch_spec TEXT;`,
  `ALTER TABLE tasks ADD COLUMN source TEXT;`,
  // Where the title came from; every task before this came from a title the user typed. The
  // default is what backfills those rows (SQLite needs one for a NOT NULL column); inserts name
  // the column anyway.
  `ALTER TABLE tasks ADD COLUMN title_source TEXT NOT NULL DEFAULT 'user';`,
  // When the user last saw the task's agent updates, in epoch milliseconds; NULL until first seen.
  // Server-owned so every client derives the same "completed and unseen" state.
  `ALTER TABLE tasks ADD COLUMN seen_at INTEGER;`,
  // The prompt a task was created from and the agent session started from it (design.md, **Domain
  // model → Task → Creation** and **Sessions**). Tasks from before have neither. The foreign key is
  // what takes the reference away when that session is removed; SQLite allows one here because the
  // column defaults to NULL.
  `ALTER TABLE tasks ADD COLUMN prompt TEXT;
   ALTER TABLE tasks ADD COLUMN primary_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;`,
  // How the session runs (design.md, decision 5). The default is what backfills the sessions from
  // before chat: every one of them runs in a terminal. Inserts name the column anyway.
  `ALTER TABLE sessions ADD COLUMN view TEXT NOT NULL DEFAULT 'terminal';`,
  // The pull or merge request opened from a task's branch (C6). Its own table, not a task column:
  // a link, a state refresh and a re-link rewrite one row and never touch the task's other fields,
  // and the state a read could not confirm is stored as `unknown` with the reason. `checks` is the
  // summary as JSON, `NULL` when the provider reports none.
  `CREATE TABLE pull_requests (
     task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
     provider TEXT NOT NULL,
     host TEXT NOT NULL,
     repository TEXT,
     number INTEGER NOT NULL,
     url TEXT NOT NULL,
     title TEXT NOT NULL,
     branch TEXT,
     base TEXT,
     state TEXT NOT NULL,
     state_reason TEXT,
     checks TEXT,
     fetched_at INTEGER
   ) STRICT;`,
];

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

export function migrate(db: DatabaseSync, migrations: readonly string[]): void {
  const applied = schemaVersion(db);
  if (applied > migrations.length)
    throw new Error(
      `database schema version ${applied} is newer than this server knows (${migrations.length})`,
    );
  for (let version = applied; version < migrations.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(migrations[version]!);
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
