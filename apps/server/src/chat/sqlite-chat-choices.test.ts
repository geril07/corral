import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { openDatabase } from "../storage/database.ts";
import { SqliteChatChoices } from "./sqlite-chat-choices.ts";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "corral-chat-choices-"));
});
afterEach(() => rm(dataDir, { recursive: true, force: true }));

/** A session row the queue's foreign key accepts. */
function seedSession(db: DatabaseSync): string {
  db.exec(
    `INSERT INTO projects (id, name, path, default_base_branch) VALUES ('p', 'p', '/p', 'main');
     INSERT INTO tasks (id, project_id, title, workspace_path, owns_worktree, state, created_at)
       VALUES ('t', 'p', 't', '/p', 0, 'active', 1);
     INSERT INTO sessions (id, task_id, kind, state, created_at)
       VALUES ('s', 't', 'pi', 'running', 1);`,
  );
  return "s";
}

function insertQueue(
  db: DatabaseSync,
  sessionId: string,
  id: string,
  text: string,
  selection: string | null,
  status: string,
): void {
  db.prepare(
    `INSERT INTO chat_queue (id, session_id, text, selection, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, sessionId, text, selection, status, 1);
}

const SELECTION = JSON.stringify({ model: { provider: "stub", id: "stub-1" }, level: null });

test("opening the store turns an interrupted attempt uncertain and a waiting one undelivered", () => {
  const db = openDatabase(dataDir);
  try {
    const sessionId = seedSession(db);
    insertQueue(db, sessionId, "queued:sending", "may have run", SELECTION, "sending");
    insertQueue(
      db,
      sessionId,
      "queued:accepted",
      "accepted, boundary unknown",
      SELECTION,
      "accepted",
    );
    insertQueue(db, sessionId, "queued:waiting", "never started", SELECTION, "queued");

    const choices = new SqliteChatChoices(db);

    expect(choices.queue(sessionId)).toMatchObject([
      { id: "queued:sending", status: "uncertain" },
      { id: "queued:accepted", status: "boundary-unknown" },
      { id: "queued:waiting", status: "undelivered" },
    ]);
  } finally {
    db.close();
  }
});

test("a queue row whose captured selection no longer parses is kept as text but never runnable", () => {
  const db = openDatabase(dataDir);
  try {
    const sessionId = seedSession(db);
    // Written after the store opened, so the constructor's recovery cannot mask the read.
    const choices = new SqliteChatChoices(db);
    insertQueue(db, sessionId, "queued:broken", "a message the user wrote", "{not json", "queued");
    insertQueue(
      db,
      sessionId,
      "queued:wrong-shape",
      "another message",
      JSON.stringify({ model: "stub-1" }),
      "queued",
    );

    expect(choices.queue(sessionId)).toEqual([
      {
        id: "queued:broken",
        text: "a message the user wrote",
        selection: null,
        status: "undelivered",
      },
      {
        id: "queued:wrong-shape",
        text: "another message",
        selection: null,
        status: "undelivered",
      },
    ]);
  } finally {
    db.close();
  }
});

test("a row without a captured selection is a message that still runs on the driver's confirmed one", () => {
  const db = openDatabase(dataDir);
  try {
    const sessionId = seedSession(db);
    const choices = new SqliteChatChoices(db);
    insertQueue(db, sessionId, "queued:no-choice", "plain", null, "queued");

    expect(choices.queue(sessionId)).toEqual([
      { id: "queued:no-choice", text: "plain", selection: null, status: "queued" },
    ]);
  } finally {
    db.close();
  }
});
