import { existsSync, readFileSync, watch, type FSWatcher, type WatchEventType } from "node:fs";
import { basename, dirname, relative, sep } from "node:path";
import { homedir } from "node:os";
import {
  AgentKind,
  defaultClientConfig,
  type AgentAvailability,
  type ClientConfig,
  type ConfigState,
} from "@corral/protocol/config";
import { isExecutable } from "../agents/executable-lookup.ts";
import { resolveInstanceEnv } from "../agents/launch-env.ts";
import { hasChatDriver } from "../chat/chat-drivers.ts";
import { ChangeFeed } from "../changes/change-feed.ts";
import { parseConfigFile, type PrivateProfile } from "./config-file.ts";

/** Editors write a file in several steps; one read after the last step is enough. */
const DEBOUNCE_MS = 50;
/** After a failed or lost watch (the directory was removed, permissions): try again. */
const REARM_MS = 1000;

export interface ConfigWatcher {
  /** The latest state read from disk, including the profiles a new session may choose. */
  state(): ConfigState;
  /** Private, current launch settings; never part of state or the RPC feed. */
  resolveInstance(
    id: string,
    source?: NodeJS.ProcessEnv,
    home?: string,
  ): ResolvedInstance | undefined;
  /** The state now and after every change on disk; unchanged reads push nothing. */
  watch(signal: AbortSignal | undefined): AsyncGenerator<ConfigState>;
  close(): void;
}

export interface ResolvedInstance extends Omit<PrivateProfile, "env" | "command"> {
  command: string;
  env: NodeJS.ProcessEnv;
  /** Values explicitly supplied by this instance, for redacting native metadata. */
  sensitiveValues: string[];
}

/**
 * Reads `filePath` and keeps watching it. The watch sits on the directory, not the file: a
 * directory event covers a file created later, an editor's atomic rename over it and an
 * in-place write alike. While that directory does not exist, the nearest existing ancestor is
 * watched instead, so a config file created together with its directory is not missed.
 * `dataDir` only supplies the default worktree root.
 */
export function watchConfigFile(filePath: string, options: { dataDir: string }): ConfigWatcher {
  const changes = new ChangeFeed();
  let current = readConfigFile(filePath, options.dataDir);
  let state = current.state;
  let watcher: FSWatcher | undefined;
  let watchedDir: string | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  let rearmTimer: NodeJS.Timeout | undefined;
  let closed = false;

  function refresh() {
    const next = readConfigFile(filePath, options.dataDir);
    current = next;
    if (sameState(next.state, state)) return;
    state = next.state;
    changes.notify();
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      if (!closed) refresh();
    }, DEBOUNCE_MS);
    refreshTimer.unref();
  }

  function scheduleRearm() {
    watcher?.close();
    watcher = undefined;
    watchedDir = undefined;
    clearTimeout(rearmTimer);
    rearmTimer = setTimeout(() => {
      rearmTimer = undefined;
      if (!closed) arm();
    }, REARM_MS);
    rearmTimer.unref();
  }

  /** The deepest existing directory above the file; the file and its own directory may be absent. */
  function watchTarget(): string | undefined {
    let dir = dirname(filePath);
    for (;;) {
      if (existsSync(dir)) return dir;
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }

  /** The first path segment from `dir` towards the file: the only entry of `dir` we care about. */
  function childOf(dir: string): string {
    return relative(dir, filePath).split(sep)[0] ?? basename(filePath);
  }

  function arm() {
    if (closed) return;
    const target = watchTarget();
    if (target === undefined || (target === watchedDir && watcher !== undefined)) return;
    watcher?.close();
    watcher = undefined;
    watchedDir = undefined;
    try {
      watcher = watch(target, (event, filename) => onEvent(target, event, filename));
      watcher.on("error", scheduleRearm);
      watchedDir = target;
    } catch {
      // An unwatchable directory (permissions, no inotify slots) must not take the server down.
      scheduleRearm();
    }
  }

  function onEvent(target: string, event: WatchEventType, filename: string | null) {
    if (closed || target !== watchedDir) return;
    if (event === "rename") {
      // The watched directory or an entry in it appeared, went away or was replaced: the watch
      // may have to move down (the config directory now exists) and the file may differ.
      arm();
      scheduleRefresh();
      return;
    }
    if (filename !== null && filename !== childOf(target)) return;
    scheduleRefresh();
  }

  arm();

  return {
    state: () => state,
    resolveInstance(id, source = process.env, home = homedir()) {
      const profile = current.privateProfiles.find((item) => item.id === id);
      if (profile === undefined) return undefined;
      const env = resolveInstanceEnv(profile.env, source, id, home);
      return {
        ...profile,
        args: [...profile.args],
        command: profile.command ?? state.config.agents[profile.agent].command.value,
        env,
        sensitiveValues: profile.env.flatMap((entry) => {
          const value = env[entry.targetName];
          return value === undefined || value === "" ? [] : [value];
        }),
      };
    },
    watch: (signal) =>
      changes.watch(() => {
        // "found" is a fact about the machine, not the file: ask the filesystem on every new
        // subscription (four `accessSync` calls), so installing an agent shows up when Settings
        // opens instead of waiting for the next save.
        state = withAvailability(state);
        return state;
      }, signal),
    close() {
      closed = true;
      clearTimeout(refreshTimer);
      clearTimeout(rearmTimer);
      watcher?.close();
      watcher = undefined;
      watchedDir = undefined;
    },
  };
}

function readConfigFile(
  filePath: string,
  dataDir: string,
): { state: ConfigState; privateProfiles: PrivateProfile[] } {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      const config = defaultClientConfig(dataDir);
      return {
        privateProfiles: [],
        state: {
          path: filePath,
          exists: false,
          config,
          profiles: [],
          agents: agentAvailability(config),
          problems: [],
        },
      };
    }
    const config = defaultClientConfig(dataDir);
    return {
      privateProfiles: [],
      state: {
        path: filePath,
        exists: true,
        config,
        profiles: [],
        agents: agentAvailability(config),
        problems: [
          {
            severity: "error",
            path: "",
            message: `cannot read the file: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      },
    };
  }
  const privateProfiles: PrivateProfile[] = [];
  const parsed = parseConfigFile(text, dataDir, undefined, privateProfiles);
  return {
    privateProfiles,
    state: {
      path: filePath,
      exists: true,
      config: parsed.config,
      profiles: parsed.profiles,
      problems: parsed.problems,
      agents: agentAvailability(parsed.config),
    },
  };
}

/** The state with its availability re-read; a subscription uses it so `found` is a live fact. */
function withAvailability(state: ConfigState): ConfigState {
  return { ...state, agents: agentAvailability(state.config) };
}

/**
 * What this host has for each agent, read on every file change and on every new subscription:
 * whether the effective command is executable (with the same lookup a launch uses) and whether
 * this build can show it as chat. Settings renders it; nothing else needs it.
 */
function agentAvailability(config: ClientConfig): AgentAvailability[] {
  return AgentKind.options.map((kind) => ({
    kind,
    found: isExecutable(config.agents[kind].command.value, process.env["PATH"]),
    chatDriver: hasChatDriver(kind),
  }));
}

/** Both states come from the same code, so key order is stable and JSON equality is state equality. */
function sameState(left: ConfigState, right: ConfigState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
