import { PullRequest } from "@corral/protocol/rpc";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const Row = PullRequest.extend({
  checks: z
    .string()
    .nullable()
    .transform((value) => (value === null ? null : JSON.parse(value))),
});

const COLUMNS = `task_id AS taskId, provider, host, repository, number, url, title, branch, base,
  state, state_reason AS stateReason, checks, fetched_at AS fetchedAt`;

/**
 * The pull or merge request opened from a task's branch (C6 decision b: its own table). A refresh
 * rewrites this row and nothing of the task's, and a state that could not be read is stored as
 * `unknown` with its reason, so a link never disappears and never turns into `closed` by accident.
 */
export class PullRequestStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  get(taskId: string): PullRequest | undefined {
    const row = this.#db
      .prepare(`SELECT ${COLUMNS} FROM pull_requests WHERE task_id = ?`)
      .get(taskId);
    return row === undefined ? undefined : Row.parse(row);
  }

  /** Stores the task's request, replacing a previous link or state. */
  put(request: PullRequest): void {
    this.#db
      .prepare(
        `INSERT INTO pull_requests (task_id, provider, host, repository, number, url, title, branch, base, state, state_reason, checks, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET
           provider = excluded.provider,
           host = excluded.host,
           repository = excluded.repository,
           number = excluded.number,
           url = excluded.url,
           title = excluded.title,
           branch = excluded.branch,
           base = excluded.base,
           state = excluded.state,
           state_reason = excluded.state_reason,
           checks = excluded.checks,
           fetched_at = excluded.fetched_at`,
      )
      .run(
        request.taskId,
        request.provider,
        request.host,
        request.repository,
        request.number,
        request.url,
        request.title,
        request.branch,
        request.base,
        request.state,
        request.stateReason,
        request.checks === null ? null : JSON.stringify(request.checks),
        request.fetchedAt,
      );
  }
}
