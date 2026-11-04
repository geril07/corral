import { agentCommand } from "@corral/protocol/config";
import type { ModelCatalog, ModelCatalogInput } from "@corral/protocol/models";
import { modelKey, modelScopeKey } from "@corral/protocol/models";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { resolveEnvRefs } from "../agents/launch-env.ts";
import type { ConfigWatcher } from "../config/config-watcher.ts";
import type { ProjectStore } from "../projects/project-store.ts";
import type { TaskStore } from "../tasks/task-store.ts";
import { releasePreviousWriter } from "../chat/writer-claim.ts";
import { readNativeCatalog, type CatalogLaunch } from "./native-catalog.ts";

const TTL_MS = 30_000;
const EMPTY: ModelCatalog = { models: [], status: "error", fetchedAt: null, message: null };

/** Lazily requested, profile/cwd/environment-scoped inventory. Preferences never trim this cache. */
export class ModelCatalogService {
  readonly #config: ConfigWatcher;
  readonly #projects: ProjectStore;
  readonly #tasks: TaskStore;
  readonly #dir: string;
  readonly #timeoutMs: number;
  readonly #cache = new Map<string, { catalog: ModelCatalog; checkedAt: number }>();
  readonly #inflight = new Map<string, Promise<ModelCatalog>>();
  readonly #active = new Set<() => Promise<void>>();
  readonly #queue: (() => void)[] = [];
  readonly #recovery: Promise<unknown>;
  #running = 0;
  #closed = false;
  constructor(options: {
    config: ConfigWatcher;
    projects: ProjectStore;
    tasks: TaskStore;
    dataDir: string;
    timeoutMs?: number;
  }) {
    this.#config = options.config;
    this.#projects = options.projects;
    this.#tasks = options.tasks;
    this.#dir = join(options.dataDir, "model-catalog");
    this.#timeoutMs = options.timeoutMs ?? 8_000;
    // A crashed server may leave native extension helpers. Records fence every later probe too.
    const paths = existsSync(this.#dir) ? readdirSync(this.#dir, { recursive: true }) : [];
    this.#recovery = Promise.all(
      paths
        .filter((p) => typeof p === "string" && p.endsWith(".json"))
        .map((p) => releasePreviousWriter(join(this.#dir, String(p)))),
    );
    void this.#recovery.catch(() => undefined);
  }
  async catalog(input: ModelCatalogInput): Promise<ModelCatalog> {
    if (this.#closed) return { ...EMPTY, message: "The server is shutting down." };
    const state = this.#config.state();
    const profile =
      input.scope.profileId === null
        ? undefined
        : state.profiles.find(
            (p) => p.id === input.scope.profileId && p.agent === input.scope.kind,
          );
    if (input.scope.profileId !== null && !profile)
      return { ...EMPTY, message: "This profile is no longer available. Choose it again." };
    if (
      input.expectedProfileRevision !== undefined &&
      profile?.revision !== input.expectedProfileRevision
    )
      return { ...EMPTY, message: "The profile changed. Review it and choose it again." };
    if (!state.config.agents[input.scope.kind].enabled.value)
      return { ...EMPTY, message: "This agent is disabled in the config file." };
    if (input.scope.kind !== "pi" && input.scope.kind !== "opencode")
      return {
        ...EMPTY,
        status: "unsupported",
        message:
          "Pre-launch discovery is not supported for this agent yet. Running chats report their own models.",
      };
    const task = input.context.taskId ? this.#tasks.get(input.context.taskId) : undefined;
    const project = input.context.projectId
      ? this.#projects.get(input.context.projectId)
      : undefined;
    if ((input.context.taskId && !task) || (input.context.projectId && !project))
      return { ...EMPTY, message: "The catalog's workspace no longer exists." };
    const cwd = task?.workspacePath ?? project?.path ?? homedir();
    let env: Record<string, string>;
    try {
      env = Object.fromEntries(
        Object.entries({
          ...process.env,
          ...resolveEnvRefs(profile?.env ?? [], process.env, profile?.id ?? null),
        }).filter(
          (pair): pair is [string, string] =>
            pair[1] !== undefined && !pair[0].startsWith("CORRAL_"),
        ),
      );
    } catch {
      return {
        ...EMPTY,
        message:
          "The profile's environment references could not be resolved. Check the server configuration.",
      };
    }
    const command = agentCommand(state.config, input.scope.kind);
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          modelScopeKey(input.scope),
          profile?.revision,
          command,
          cwd,
          Object.entries(env).toSorted(([a], [b]) => a.localeCompare(b)),
        ]),
      )
      .digest("hex");
    const cached = this.#cache.get(key);
    if (!input.refresh && cached && Date.now() - cached.checkedAt < TTL_MS) return cached.catalog;
    const pending = this.#inflight.get(key);
    if (pending) return pending;
    const launch: CatalogLaunch = {
      kind: input.scope.kind,
      command,
      cwd,
      env,
      model: profile?.model ?? null,
      provider: profile?.provider ?? null,
      recordDir: join(this.#dir, key),
      timeoutMs: this.#timeoutMs,
    };
    const previous = cached?.catalog.fetchedAt != null ? cached.catalog : undefined;
    const request = this.#read(key, launch, previous);
    this.#inflight.set(key, request);
    try {
      return await request;
    } finally {
      this.#inflight.delete(key);
    }
  }
  async #read(
    key: string,
    launch: CatalogLaunch,
    cached: ModelCatalog | undefined,
  ): Promise<ModelCatalog> {
    let acquired = false;
    let catalog: ModelCatalog;
    try {
      await this.#recovery;
      if (this.#running >= 2) {
        if (this.#queue.length >= 24) throw new Error("metadata queue full");
        await new Promise<void>((resolve) => this.#queue.push(resolve));
      }
      if (this.#closed) throw new Error("shutting down");
      this.#running++;
      acquired = true;
      const result = await readNativeCatalog(launch, this.#active);
      const models = [...new Map(result.models.map((m) => [modelKey(m), m])).values()];
      // A partial, smaller snapshot must not replace a previously useful inventory.
      const retained =
        result.partial && cached
          ? [...new Map([...cached.models, ...models].map((m) => [modelKey(m), m])).values()]
          : models;
      catalog = {
        models: retained,
        status: result.partial ? "partial" : "ready",
        fetchedAt: Date.now(),
        message: result.partial
          ? "Incomplete startup snapshot. Refresh to look for more models."
          : null,
      };
    } catch {
      catalog = cached
        ? {
            ...cached,
            status: "stale",
            message:
              "Refresh failed; showing the previous catalog. Check the executable, credentials and extensions, then retry.",
          }
        : {
            ...EMPTY,
            message:
              "Could not read models. Check the executable, credentials and extensions, then retry.",
          };
    } finally {
      if (acquired) {
        this.#running--;
        this.#queue.shift()?.();
      }
    }
    this.#cache.delete(key);
    this.#cache.set(key, { catalog, checkedAt: Date.now() });
    while (this.#cache.size > 64) this.#cache.delete(this.#cache.keys().next().value!);
    return catalog;
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const release of this.#queue.splice(0)) release();
    await Promise.all([...this.#active].map((stop) => stop()));
    await Promise.allSettled(this.#inflight.values());
  }
}
