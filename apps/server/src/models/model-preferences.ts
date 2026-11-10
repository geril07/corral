import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { ChatModelRef } from "@corral/protocol/chat";
import {
  ModelPolicy,
  ModelRule,
  defaultModelPolicy,
  modelScopeKey,
  type ModelPreferences,
  ModelScope,
} from "@corral/protocol/models";
import { ChangeFeed } from "../changes/change-feed.ts";

export const MODEL_PREFERENCES_FILE = "models.toml";

// TOML has no null: an omitted provider/profile means the native/default scope.
const StoredRule = z.discriminatedUnion("type", [
  ModelRule.options[0],
  ModelRule.options[1].extend({ provider: ModelRule.options[1].shape.provider.default(null) }),
]);
const StoredModelRef = ChatModelRef.extend({
  provider: ChatModelRef.shape.provider.default(null),
});
const StoredPolicy = z
  .object({
    mode: z.enum(["all", "allow"]).default("all"),
    allow: z.array(StoredRule).default([]),
    deny: z.array(StoredRule).default([]),
    favorites: z.array(StoredModelRef).default([]),
    providerOrder: z.array(z.string()).max(10000).default([]),
    modelOrder: z.array(StoredModelRef).max(10000).default([]),
  })
  .strict();
const StoredPreference = z
  .object({
    scope: ModelScope.extend({ profileId: ModelScope.shape.profileId.default(null) }).strict(),
    policy: StoredPolicy,
  })
  .strict();
const PreferenceFile = z
  .object({ preferences: z.array(StoredPreference).max(10000).default([]) })
  .strict();

export class ModelPreferencesChangedError extends Error {}
export class ModelPreferencesConfigError extends Error {
  constructor() {
    super("Could not read model preferences. Check models.toml before saving.");
  }
}

/** The model-preference config is separate so UI saves never rewrite the user's launch config. */
export class ModelPreferencesStore {
  readonly #file: string;
  readonly #changes = new ChangeFeed();
  readonly #listener: () => void;
  #signature = "";
  #closed = false;

  constructor(configDir: string) {
    this.#file = join(configDir, MODEL_PREFERENCES_FILE);
    this.#listener = () => this.#notify();
    this.#notify();
    // watchFile also follows atomic replacement and a config directory created after startup.
    watchFile(this.#file, { persistent: false, interval: 250 }, this.#listener);
  }

  list(): ModelPreferences[] {
    let text: string;
    try {
      text = readFileSync(this.#file, "utf8");
    } catch (error) {
      if (isMissing(error)) return [];
      throw new ModelPreferencesConfigError();
    }
    try {
      const file = PreferenceFile.parse(parse(text));
      const seen = new Set<string>();
      return file.preferences
        .map(({ scope, policy: stored }) => {
          const key = modelScopeKey(scope);
          if (seen.has(key)) throw new ModelPreferencesConfigError();
          seen.add(key);
          // Normalize defaults so the revision tracks the effective policy, not file formatting.
          const policy = ModelPolicy.parse(stored);
          // Content, not a hand-maintained counter: an external edit must invalidate stale saves.
          const revision = Number.parseInt(
            createHash("sha256")
              .update(JSON.stringify({ scope, policy }))
              .digest("hex")
              .slice(0, 13),
            16,
          );
          return { scope, revision: revision || 1, policy };
        })
        .toSorted((a, b) => modelScopeKey(a.scope).localeCompare(modelScopeKey(b.scope)));
    } catch {
      // Parser diagnostics can quote arbitrary file contents; never put those on the wire.
      throw new ModelPreferencesConfigError();
    }
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
    if (this.#closed) throw new Error("The model preference store is closed.");
    const records = this.list();
    const key = modelScopeKey(input.scope);
    const current = records.find((record) => modelScopeKey(record.scope) === key);
    if ((current?.revision ?? 0) !== input.revision) throw new ModelPreferencesChangedError();
    const policy = ModelPolicy.parse(input.policy);
    const preferences = records
      .filter((record) => modelScopeKey(record.scope) !== key)
      .map((record) => ({ scope: record.scope, policy: record.policy }));
    preferences.push({ scope: input.scope, policy });
    preferences.sort((a, b) => modelScopeKey(a.scope).localeCompare(modelScopeKey(b.scope)));

    const dir = dirname(this.#file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = join(dir, `.models-${randomUUID()}.tmp`);
    try {
      const descriptor = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(descriptor, stringify({ preferences }), "utf8");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporary, this.#file);
    } finally {
      rmSync(temporary, { force: true });
    }
    this.#notify();
    return this.get(input.scope);
  }

  watch(signal: AbortSignal | undefined): AsyncGenerator<ModelPreferences[]> {
    return this.#changes.watch(() => this.list(), signal);
  }

  close(): void {
    this.#closed = true;
    unwatchFile(this.#file, this.#listener);
  }

  #notify(): void {
    let signature: string;
    try {
      signature = JSON.stringify(this.list());
    } catch {
      signature = "unreadable";
    }
    if (signature === this.#signature) return;
    this.#signature = signature;
    this.#changes.notify();
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
