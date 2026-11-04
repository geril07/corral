import type { DatabaseSync } from "node:sqlite";
import {
  ModelPolicy,
  defaultModelPolicy,
  modelScopeKey,
  type ModelPreferences,
  ModelScope,
} from "@corral/protocol/models";
import { ChangeFeed } from "../changes/change-feed.ts";

export class ModelPreferencesChangedError extends Error {}

export class ModelPreferencesStore {
  readonly #db: DatabaseSync;
  readonly #changes = new ChangeFeed();
  constructor(db: DatabaseSync) {
    this.#db = db;
  }
  list(): ModelPreferences[] {
    return this.#db
      .prepare("SELECT scope, revision, policy FROM model_preferences ORDER BY scope")
      .all()
      .map((row) => ({
        scope: ModelScope.parse(JSON.parse(String(row["scope"]))),
        revision: Number(row["revision"]),
        policy: ModelPolicy.parse(JSON.parse(String(row["policy"]))),
      }));
  }
  get(scope: ModelScope): ModelPreferences {
    return (
      this.list().find((row) => modelScopeKey(row.scope) === modelScopeKey(scope)) ?? {
        scope,
        revision: 0,
        policy: defaultModelPolicy(),
      }
    );
  }
  save(input: ModelPreferences): ModelPreferences {
    const scope = modelScopeKey(input.scope);
    const next = { ...input, revision: input.revision + 1 };
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#db
        .prepare("SELECT revision FROM model_preferences WHERE scope = ?")
        .get(scope);
      if (Number(current?.["revision"] ?? 0) !== input.revision)
        throw new ModelPreferencesChangedError();
      this.#db
        .prepare(
          "INSERT INTO model_preferences (scope, revision, policy) VALUES (?, ?, ?) ON CONFLICT(scope) DO UPDATE SET revision = excluded.revision, policy = excluded.policy",
        )
        .run(scope, next.revision, JSON.stringify(input.policy));
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    this.#changes.notify();
    return next;
  }
  watch(signal: AbortSignal | undefined): AsyncGenerator<ModelPreferences[]> {
    return this.#changes.watch(() => this.list(), signal);
  }
}
