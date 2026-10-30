import { Session } from "@corral/protocol/rpc";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/** What is persisted of a session; the terminal is not (decision 12). */
export const StoredSession = Session.omit({ terminalId: true, status: true });
export type StoredSession = z.infer<typeof StoredSession>;

const COLUMNS = `id, task_id AS taskId, kind, agent_session_id AS agentSessionId, state,
  created_at AS createdAt`;

export class SessionStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  list(): StoredSession[] {
    return this.#db
      .prepare(`SELECT ${COLUMNS} FROM sessions ORDER BY rowid`)
      .all()
      .map((row) => StoredSession.parse(row));
  }

  get(id: string): StoredSession | undefined {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM sessions WHERE id = ?`).get(id);
    return row && StoredSession.parse(row);
  }

  /** The sessions that were running when their task was settled and start again when it is not. */
  listResumableOnUnsettle(taskId: string): StoredSession[] {
    return this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM sessions WHERE task_id = ? AND resume_on_unsettle = 1 ORDER BY rowid`,
      )
      .all(taskId)
      .map((row) => StoredSession.parse(row));
  }

  /** The agent session ids that sessions of `kind` already hold. */
  agentSessionIds(kind: StoredSession["kind"]): Set<string> {
    return new Set(
      this.#db
        .prepare(
          "SELECT agent_session_id FROM sessions WHERE kind = ? AND agent_session_id IS NOT NULL",
        )
        .all(kind)
        .map((row) => z.string().parse(row["agent_session_id"])),
    );
  }

  insert(session: StoredSession): void {
    this.#db
      .prepare(
        `INSERT INTO sessions (id, task_id, kind, agent_session_id, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.taskId,
        session.kind,
        session.agentSessionId,
        session.state,
        session.createdAt,
      );
  }

  setState(id: string, state: StoredSession["state"]): void {
    this.#db.prepare("UPDATE sessions SET state = ? WHERE id = ?").run(state, id);
  }

  setResumeOnUnsettle(id: string, resume: boolean): void {
    this.#db
      .prepare("UPDATE sessions SET resume_on_unsettle = ? WHERE id = ?")
      .run(resume ? 1 : 0, id);
  }

  setAgentSessionId(id: string, agentSessionId: string): void {
    this.#db
      .prepare("UPDATE sessions SET agent_session_id = ? WHERE id = ?")
      .run(agentSessionId, id);
  }

  delete(id: string): void {
    this.#db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }
}
