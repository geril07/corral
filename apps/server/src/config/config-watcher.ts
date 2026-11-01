import { existsSync, readFileSync, watch, type FSWatcher, type WatchEventType } from "node:fs";
import { basename, dirname, relative, sep } from "node:path";
import { defaultClientConfig, type ConfigState } from "@corral/protocol/config";
import { ChangeFeed } from "../changes/change-feed.ts";
import { parseConfigFile } from "./config-file.ts";

/** Editors write a file in several steps; one read after the last step is enough. */
const DEBOUNCE_MS = 50;
/** After a failed or lost watch (the directory was removed, permissions): try again. */
const REARM_MS = 1000;

export interface ConfigWatcher {
  /** The latest state read from disk, including the profiles a new session may choose. */
  state(): ConfigState;
  /** The state now and after every change on disk; unchanged reads push nothing. */
  watch(signal: AbortSignal | undefined): AsyncGenerator<ConfigState>;
  close(): void;
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
  let state = readConfigFile(filePath, options.dataDir);
  let watcher: FSWatcher | undefined;
  let watchedDir: string | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  let rearmTimer: NodeJS.Timeout | undefined;
  let closed = false;

  function refresh() {
    const next = readConfigFile(filePath, options.dataDir);
    if (sameState(next, state)) return;
    state = next;
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
    watch: (signal) => changes.watch(() => state, signal),
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

function readConfigFile(filePath: string, dataDir: string): ConfigState {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (error) {
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { path: filePath, config: defaultClientConfig(dataDir), profiles: [], problems: [] };
    }
    return {
      path: filePath,
      config: defaultClientConfig(dataDir),
      profiles: [],
      problems: [
        {
          severity: "error",
          path: "",
          message: `cannot read the file: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
  return { path: filePath, ...parseConfigFile(text, dataDir) };
}

/** Both states come from the same code, so key order is stable and JSON equality is state equality. */
function sameState(left: ConfigState, right: ConfigState): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
