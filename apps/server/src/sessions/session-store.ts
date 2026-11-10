import { LaunchSnapshot, Session } from "@corral/protocol/rpc";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { PrivateLaunchSpec } from "./private-launch.ts";

/**
 * What is persisted of a session; the terminal and its transient status are not (decision 12).
 * `launchError` is not persisted: a restore failure is reported by the server run that saw it.
 */
export const StoredSession = Session.omit({
  terminalId: true,
  status: true,
  launchError: true,
}).extend({ launch: LaunchSnapshot.nullable() });
export type StoredSession = z.infer<typeof StoredSession>;

const COLUMNS = `id, task_id AS taskId, kind, view, agent_session_id AS agentSessionId, state, label,
  created_at AS createdAt, launch_spec AS launchSpec`;

function fromRow(row: unknown): StoredSession {
  const { launchSpec, ...rest } = z.record(z.string(), z.unknown()).parse(row);
  return StoredSession.parse({
    ...rest,
    launch: typeof launchSpec === "string" ? (JSON.parse(launchSpec) as unknown) : null,
  });
}

export class SessionStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  list(): StoredSession[] {
    return this.#db.prepare(`SELECT ${COLUMNS} FROM sessions ORDER BY rowid`).all().map(fromRow);
  }

  get(id: string): StoredSession | undefined {
    const row = this.#db.prepare(`SELECT ${COLUMNS} FROM sessions WHERE id = ?`).get(id);
    return row && fromRow(row);
  }

  /**
   * The private launch data captured at start: literal environment values and the resolved
   * executable/argv. It never travels with `StoredSession`, so a session list or watch cannot
   * leak it; only a launch reads it.
   */
  privateLaunch(id: string): PrivateLaunchSpec | undefined {
    const row = this.#db
      .prepare("SELECT spec FROM session_launch_specs WHERE session_id = ?")
      .get(id);
    if (row === undefined) return undefined;
    return PrivateLaunchSpec.parse(JSON.parse(z.string().parse(row["spec"])));
  }

  /** The sessions that were running when their task was settled and start again when it is not. */
  listResumableOnUnsettle(taskId: string): StoredSession[] {
    return this.#db
      .prepare(
        `SELECT ${COLUMNS} FROM sessions WHERE task_id = ? AND resume_on_unsettle = 1 ORDER BY rowid`,
      )
      .all(taskId)
      .map(fromRow);
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

  /**
   * Writes the session row and, when it is an agent session, its private launch data. Two
   * statements rather than a nested transaction: a caller may already be inside one (the task
   * insert's deferred foreign key). A missing private row is not fatal — a restart falls back to
   * the effective agent command — while a missing session row would lose the user's session.
   */
  insert(session: StoredSession, privateLaunch?: PrivateLaunchSpec | null): void {
    this.#db
      .prepare(
        `INSERT INTO sessions
           (id, task_id, kind, view, agent_session_id, state, label, created_at, launch_spec)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.taskId,
        session.kind,
        session.view,
        session.agentSessionId,
        session.state,
        session.label ?? null,
        session.createdAt,
        session.launch === null ? null : JSON.stringify(session.launch),
      );
    if (privateLaunch != null) this.setPrivateLaunch(session.id, privateLaunch);
  }

  setPrivateLaunch(id: string, spec: PrivateLaunchSpec): void {
    this.#db
      .prepare(
        `INSERT INTO session_launch_specs (session_id, spec) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET spec = excluded.spec`,
      )
      .run(id, JSON.stringify(spec));
  }

  setState(id: string, state: StoredSession["state"]): void {
    this.#db.prepare("UPDATE sessions SET state = ? WHERE id = ?").run(state, id);
  }

  /** The view the session opens in; its next start runs in this one. */
  setView(id: string, view: StoredSession["view"]): void {
    this.#db.prepare("UPDATE sessions SET view = ? WHERE id = ?").run(view, id);
  }

  /** `null` takes the user's name away, restoring the natural label. */
  setLabel(id: string, label: string | null): void {
    this.#db.prepare("UPDATE sessions SET label = ? WHERE id = ?").run(label, id);
  }

  setResumeOnUnsettle(id: string, resume: boolean): void {
    this.#db
      .prepare("UPDATE sessions SET resume_on_unsettle = ? WHERE id = ?")
      .run(resume ? 1 : 0, id);
  }

  /** Sets the agent's conversation id; `null` forgets one that cannot be resumed. */
  setAgentSessionId(id: string, agentSessionId: string | null): void {
    this.#db
      .prepare("UPDATE sessions SET agent_session_id = ? WHERE id = ?")
      .run(agentSessionId, id);
  }

  delete(id: string): void {
    this.#db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }
}
