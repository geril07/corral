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
