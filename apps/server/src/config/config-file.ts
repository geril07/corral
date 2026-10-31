import {
  ActionId,
  AgentKind,
  DEFAULT_BINDINGS,
  DEFAULT_PREFIX,
  TaskView,
  WorkspaceMode,
  SlugMode,
  defaultClientConfig,
  defaultNamingSettings,
  type ClientConfig,
  type ConfigProblem,
  type EnvRef,
  type LaunchProfile,
  type NamingSettings,
  type ResolvedTaskSettings,
  type SettingSource,
} from "@corral/protocol/config";
import { formatChord, parseChord, type Chord } from "@corral/protocol/keymap";
import { createHash } from "node:crypto";
import { isAbsolute, join, normalize, sep } from "node:path";
import { parse as parseToml, TomlError } from "smol-toml";
import { MODEL_ID, launchChoiceProblems, supportsModel } from "../agents/launch-capabilities.ts";
import { ENV_NAME, isReservedEnvName } from "../agents/launch-env.ts";

const PREFIX_PATH = "keys.prefix";
const BINDINGS_PATH = "keys.bindings";
const PROFILES_PATH = "profiles";
const TASKS_PATH = "tasks";
const NAMING_PATH = "naming";
const PROJECTS_PATH = "projects";
const SECTIONS = new Set(["keys", PROFILES_PATH, TASKS_PATH, NAMING_PATH, PROJECTS_PATH]);
const PROFILE_KEYS = new Set(["name", "agent", "model", "provider", "env"]);
const ENV_KEYS = new Set(["targetName", "fromEnv"]);
const PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_PROFILE_NAME = 80;
const MAX_ENV_REFS = 32;

/** The keys `[tasks]` and `[projects."<path>"]` share. */
const TASK_KEYS: ReadonlySet<string> = new Set([
  "agent",
  "profile",
  "model",
  "workspace",
  "worktree-root",
  "branch-prefix",
  "slug-mode",
  "view",
]);
const NAMING_KEYS: ReadonlySet<string> = new Set(["profile", "agent", "model", "timeout-seconds"]);

/** One full set of task settings, before or after a layer is applied. */
interface TaskValues {
  agent: AgentKind | null;
  profile: string | null;
  model: string | null;
  workspace: WorkspaceMode;
  worktreeRoot: string;
  branchPrefix: string;
  slugMode: SlugMode;
  view: TaskView;
}

/** The entries one table (`[tasks]` or a project's) sets; a missing key falls through. */
type TaskLayer = { [K in keyof TaskValues]?: TaskValues[K] };

interface NamingValues {
  profile: string | null;
  agent: AgentKind | null;
  model: string | null;
  timeoutSeconds: number;
}

type NamingLayer = { [K in keyof NamingValues]?: NamingValues[K] };

export interface ParsedConfigFile {
  config: ClientConfig;
  profiles: LaunchProfile[];
  problems: ConfigProblem[];
}

/** The configuration before the file; the worktree root default is below the server's data dir. */
export function defaultConfig(dataDir: string): ClientConfig {
  return defaultClientConfig(join(dataDir, "worktrees"));
}

/** A binding the file set: a chord, or no chord (`""` unbinds the action). */
type FileBinding = { text: string; chord: Chord } | { text: null };

/**
 * File text to the effective config: the defaults with every valid entry applied, and one
 * problem per rejected entry. Pure: no file access, the caller reads the text. `dataDir` only
 * supplies the default worktree root (`<data dir>/worktrees`).
 */
export function parseConfigFile(text: string, dataDir: string): ParsedConfigFile {
  const problems: ConfigProblem[] = [];
  const config = defaultConfig(dataDir);
  let document: unknown;
  try {
    document = parseToml(text);
  } catch (error) {
    return { config, profiles: [], problems: [tomlProblem(error)] };
  }
  if (!isTable(document))
    return { config, profiles: [], problems: [errorAt("", "the file is not a table")] };

  const keys = document["keys"];
  for (const key of Object.keys(document)) {
    if (!SECTIONS.has(key)) problems.push(errorAt(key, `unknown section "${key}"`));
  }
  const profiles = validProfiles(document["profiles"], problems);
  const profileIds = new Set(profiles.map((profile) => profile.id));
  const tasks = taskLayer(document[TASKS_PATH], TASKS_PATH, problems, profileIds);
  const naming = namingLayer(document[NAMING_PATH], problems, profileIds);
  config.tasks = resolveTaskSettings(tasks, undefined, dataDir);
  config.naming = resolvedNaming(naming);
  config.projects = resolvedProjects(document[PROJECTS_PATH], tasks, dataDir, problems, profileIds);
  if (keys !== undefined && !isTable(keys)) {
    problems.push(errorAt("keys", `expected a table, got ${describe(keys)}`));
  } else if (keys !== undefined) {
    for (const key of Object.keys(keys)) {
      if (key !== "prefix" && key !== "bindings")
        problems.push(errorAt(`keys.${key}`, `unknown key "${key}"`));
    }
  }
  const prefix: { text: string; chord: Chord } | undefined = validPrefix(keys, problems);
  const bindings = validBindings(keys, problems);

  const droppedPrefix = { value: false };
  const droppedBindings = new Set<ActionId>();
  /** The entries that apply right now: the file's valid ones unless a conflict dropped them. */
  const assignments = (): Assignment[] => {
    const list: Assignment[] = [
      {
        path: PREFIX_PATH,
        name: "the prefix",
        explicit: prefix !== undefined && !droppedPrefix.value,
        chord: parseChord(
          prefix !== undefined && !droppedPrefix.value ? prefix.text : DEFAULT_PREFIX,
        ),
        drop: () => (droppedPrefix.value = true),
      },
    ];
    for (const action of ActionId.options) {
      const binding = bindings.get(action);
      const applied = binding !== undefined && !droppedBindings.has(action) ? binding : undefined;
      if (applied?.text === null) continue;
      list.push({
        path: `${BINDINGS_PATH}.${action}`,
        name: action,
        explicit: applied !== undefined,
        chord: applied?.chord ?? parseChord(DEFAULT_BINDINGS[action]),
        drop: () => droppedBindings.add(action),
      });
    }
    return list;
  };

  // A chord may not serve two actions. Every file entry in a conflict falls back to its
  // default, and a fallback can collide in turn, so repeat until nothing conflicts.
  while (true) {
    const conflicts = conflictsOf(assignments());
    const toDrop = conflicts.flatMap((group) => group.filter((entry) => entry.explicit));
    if (toDrop.length === 0) break;
    for (const group of conflicts) {
      const names = group.map((entry) => entry.name);
      for (const entry of group) {
        if (!entry.explicit) continue;
        entry.drop();
        const others = names.filter((name) => name !== entry.name).join(" and ");
        problems.push(
          errorAt(entry.path, `the chord "${formatChord(entry.chord)}" is also used by ${others}`),
        );
      }
    }
  }

  for (const entry of assignments()) {
    if (entry.explicit && isBrowserOwned(entry.chord)) {
      problems.push({
        severity: "warning",
        path: entry.path,
        message: `the browser keeps "${formatChord(entry.chord)}" for itself, so the page may never see it`,
      });
    }
  }

  config.keys.prefix = prefix !== undefined && !droppedPrefix.value ? prefix.text : DEFAULT_PREFIX;
  for (const action of ActionId.options) {
    const binding = bindings.get(action);
    config.keys.bindings[action] =
      binding !== undefined && !droppedBindings.has(action)
        ? binding.text
        : DEFAULT_BINDINGS[action];
  }
  return { config, profiles, problems };
}

interface Assignment {
  /** Dotted path in the file the entry came from. */
  path: string;
  /** How the problem messages call it. */
  name: string;
  /** False for a default that nothing in the file overrides: a conflict never drops it. */
  explicit: boolean;
  chord: Chord;
  drop(): void;
}

function conflictsOf(assignments: Assignment[]): Assignment[][] {
  const byChord = new Map<string, Assignment[]>();
  for (const assignment of assignments) {
    const key = formatChord(assignment.chord);
    byChord.set(key, [...(byChord.get(key) ?? []), assignment]);
  }
  return [...byChord.values()].filter((group) => group.length > 1);
}

function validPrefix(
  keys: unknown,
  problems: ConfigProblem[],
): { text: string; chord: Chord } | undefined {
  if (!isTable(keys)) return undefined;
  const text = keys["prefix"];
  if (text === undefined) return undefined;
  if (typeof text !== "string") {
    problems.push(errorAt(PREFIX_PATH, `expected a string, got ${describe(text)}`));
    return undefined;
  }
  try {
    return { text, chord: parseChord(text) };
  } catch (error) {
    problems.push(errorAt(PREFIX_PATH, messageOf(error)));
    return undefined;
  }
}

/**
 * Profiles are all-or-nothing: one unknown key, bad type, reserved variable or unsupported
 * model/provider drops the whole profile, so a selectable profile always describes the launch
 * that will happen. Messages never quote a file value, which may be a secret.
 */
function validProfiles(value: unknown, problems: ConfigProblem[]): LaunchProfile[] {
  if (value === undefined) return [];
  if (!isTable(value)) {
    problems.push(errorAt(PROFILES_PATH, `expected a table, got ${describe(value)}`));
    return [];
  }
  const profiles: LaunchProfile[] = [];
  for (const [id, entry] of Object.entries(value)) {
    if (!PROFILE_ID.test(id)) {
      problems.push(
        errorAt(
          PROFILES_PATH,
          "a profile id must be letters, digits, dot, underscore or dash, starting with a letter or digit",
        ),
      );
      continue;
    }
    const path = `${PROFILES_PATH}.${id}`;
    if (!isTable(entry)) {
      problems.push(errorAt(path, `expected a table, got ${describe(entry)}`));
      continue;
    }
    const issues: string[] = [];
    for (const key of Object.keys(entry)) {
      if (!PROFILE_KEYS.has(key)) issues.push("unknown key in the profile");
    }
    const name = profileName(entry["name"], issues);
    const parsedAgent = AgentKind.safeParse(entry["agent"]);
    const agent = parsedAgent.success ? parsedAgent.data : null;
    if (agent === null) issues.push(`agent must be one of ${AgentKind.options.join(", ")}`);
    const model = textField(entry["model"], "model", issues);
    const provider = textField(entry["provider"], "provider", issues);
    const env = profileEnv(entry["env"], issues);
    if (agent !== null) {
      for (const problem of launchChoiceProblems({ kind: agent, model, provider })) {
        issues.push(problem.message);
      }
    }
    if (issues.length > 0 || agent === null) {
      for (const message of issues) problems.push(errorAt(path, message));
      continue;
    }
    const definition = { id, name, agent, model, provider, env };
    profiles.push({ ...definition, revision: profileRevision(definition) });
  }
  return profiles;
}

function profileName(value: unknown, issues: string[]): string {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push("the profile needs a non-empty name");
    return "";
  }
  if (value.length > MAX_PROFILE_NAME) {
    issues.push(`the profile name may be at most ${MAX_PROFILE_NAME} characters`);
  }
  // oxlint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    issues.push("the profile name may not hold control characters");
  }
  return value.trim();
}

function textField(value: unknown, field: string, issues: string[]): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string") {
    issues.push(`${field} must be a string`);
    return null;
  }
  return value;
}

function profileEnv(value: unknown, issues: string[]): EnvRef[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push("env must be an array of { targetName, fromEnv } tables");
    return [];
  }
  if (value.length > MAX_ENV_REFS) {
    issues.push(`env may hold at most ${MAX_ENV_REFS} references`);
    return [];
  }
  const refs: EnvRef[] = [];
  const targets = new Set<string>();
  for (const item of value) {
    if (!isTable(item)) {
      issues.push("each env entry must be a table");
      continue;
    }
    for (const key of Object.keys(item)) {
      if (!ENV_KEYS.has(key)) {
        issues.push(
          "an env entry holds only targetName and fromEnv; literal values are not supported",
        );
      }
    }
    const targetName = item["targetName"];
    const fromEnv = item["fromEnv"];
    if (typeof targetName !== "string" || !ENV_NAME.test(targetName)) {
      issues.push("env targetName must be an environment variable name");
      continue;
    }
    if (typeof fromEnv !== "string" || !ENV_NAME.test(fromEnv)) {
      issues.push("env fromEnv must be an environment variable name");
      continue;
    }
    if (isReservedEnvName(targetName)) {
      issues.push("env may not set a reserved variable");
      continue;
    }
    if (targets.has(targetName)) {
      issues.push("env sets the same variable twice");
      continue;
    }
    targets.add(targetName);
    refs.push({ targetName, fromEnv });
  }
  return refs;
}

/**
 * A `[tasks]` or `[projects."<path>"]` table: every valid entry, and one problem per rejected
 * one. A rejected entry is dropped alone, so the rest of the table still applies.
 */
function taskLayer(
  value: unknown,
  base: string,
  problems: ConfigProblem[],
  profileIds: ReadonlySet<string>,
): TaskLayer {
  if (value === undefined) return {};
  if (!isTable(value)) {
    problems.push(errorAt(base, `expected a table, got ${describe(value)}`));
    return {};
  }
  for (const key of Object.keys(value)) {
    if (!TASK_KEYS.has(key)) problems.push(errorAt(`${base}.${key}`, `unknown key "${key}"`));
  }
  const layer: TaskLayer = {};
  const agent = choiceField(AgentKind.options, value["agent"], `${base}.agent`, problems);
  if (agent !== undefined) layer.agent = agent;
  const profile = profileRef(value["profile"], `${base}.profile`, problems, profileIds);
  if (profile !== undefined) layer.profile = profile;
  const model = modelField(value["model"], `${base}.model`, agent, problems);
  if (model !== undefined) layer.model = model;
  const workspace = choiceField(
    WorkspaceMode.options,
    value["workspace"],
    `${base}.workspace`,
    problems,
  );
  if (workspace !== undefined) layer.workspace = workspace;
  const root = worktreeRoot(value["worktree-root"], `${base}.worktree-root`, problems);
  if (root !== undefined) layer.worktreeRoot = root;
  const prefix = branchPrefix(value["branch-prefix"], `${base}.branch-prefix`, problems);
  if (prefix !== undefined) layer.branchPrefix = prefix;
  const slugMode = choiceField(SlugMode.options, value["slug-mode"], `${base}.slug-mode`, problems);
  if (slugMode !== undefined) layer.slugMode = slugMode;
  const view = taskView(value["view"], `${base}.view`, problems);
  if (view !== undefined) layer.view = view;
  return layer;
}

/** `[naming]`: a profile or an agent and model, and how long to wait for it. */
function namingLayer(
  value: unknown,
  problems: ConfigProblem[],
  profileIds: ReadonlySet<string>,
): NamingLayer {
  if (value === undefined) return {};
  if (!isTable(value)) {
    problems.push(errorAt(NAMING_PATH, `expected a table, got ${describe(value)}`));
    return {};
  }
  for (const key of Object.keys(value)) {
    if (!NAMING_KEYS.has(key))
      problems.push(errorAt(`${NAMING_PATH}.${key}`, `unknown key "${key}"`));
  }
  const layer: NamingLayer = {};
  const profile = profileRef(value["profile"], `${NAMING_PATH}.profile`, problems, profileIds);
  if (profile !== undefined) layer.profile = profile;
  const agent = choiceField(AgentKind.options, value["agent"], `${NAMING_PATH}.agent`, problems);
  if (agent !== undefined) layer.agent = agent;
  const model = modelField(value["model"], `${NAMING_PATH}.model`, agent, problems);
  if (model !== undefined) {
    // Unlike `[tasks]`, naming runs unattended: a model nobody names an agent or profile for
    // would never be used, so it is a problem of its own.
    if (agent === undefined && profile === undefined) {
      problems.push(
        errorAt(`${NAMING_PATH}.model`, "naming needs a profile or an agent to use that model"),
      );
    } else {
      layer.model = model;
    }
  }
  const timeout = timeoutSeconds(
    value["timeout-seconds"],
    `${NAMING_PATH}.timeout-seconds`,
    problems,
  );
  if (timeout !== undefined) layer.timeoutSeconds = timeout;
  return layer;
}

/** Each configured project's table, resolved against `[tasks]`. Keys match `Project.path`. */
function resolvedProjects(
  value: unknown,
  global: TaskLayer,
  dataDir: string,
  problems: ConfigProblem[],
  profileIds: ReadonlySet<string>,
): Record<string, ResolvedTaskSettings> {
  if (value === undefined) return {};
  if (!isTable(value)) {
    problems.push(errorAt(PROJECTS_PATH, `expected a table, got ${describe(value)}`));
    return {};
  }
  const projects: Record<string, ResolvedTaskSettings> = {};
  for (const [path, entry] of Object.entries(value)) {
    const base = `${PROJECTS_PATH}."${path}"`;
    const pathProblem = projectPathProblem(path);
    if (pathProblem !== undefined) {
      problems.push(errorAt(base, pathProblem));
      continue;
    }
    if (!isTable(entry)) {
      problems.push(errorAt(base, `expected a table, got ${describe(entry)}`));
      continue;
    }
    projects[path] = resolveTaskSettings(
      global,
      taskLayer(entry, base, problems, profileIds),
      dataDir,
    );
  }
  return projects;
}

/**
 * Decision 17's resolution for one project: built-in default, then `[tasks]`, then the
 * project's own table. The result says which layer each value came from, so no client has to
 * look it up.
 */
export function resolveTaskSettings(
  global: TaskLayer,
  project: TaskLayer | undefined,
  dataDir: string,
): ResolvedTaskSettings {
  const builtin: TaskValues = {
    agent: null,
    profile: null,
    model: null,
    workspace: "main-worktree",
    worktreeRoot: join(dataDir, "worktrees"),
    branchPrefix: "",
    slugMode: "title",
    view: "terminal",
  };
  const resolved = <K extends keyof TaskValues>(key: K) => {
    const source: SettingSource =
      project?.[key] !== undefined ? "project" : global[key] !== undefined ? "global" : "default";
    return { value: project?.[key] ?? global[key] ?? builtin[key], source };
  };
  return {
    agent: resolved("agent"),
    profile: resolved("profile"),
    model: resolved("model"),
    workspace: resolved("workspace"),
    worktreeRoot: resolved("worktreeRoot"),
    branchPrefix: resolved("branchPrefix"),
    slugMode: resolved("slugMode"),
    view: resolved("view"),
  };
}

/** `[naming]` has no per-project layer, so a value is either the built-in default or the file's. */
function resolvedNaming(layer: NamingLayer): NamingSettings {
  const defaults = defaultNamingSettings();
  const resolved = <K extends keyof NamingValues>(key: K) => {
    const applied = layer[key];
    if (applied === undefined) return defaults[key];
    const source: SettingSource = "global";
    return { value: applied, source };
  };
  return {
    profile: resolved("profile"),
    agent: resolved("agent"),
    model: resolved("model"),
    timeoutSeconds: resolved("timeoutSeconds"),
  };
}

function choiceField<T extends string>(
  options: readonly T[],
  value: unknown,
  path: string,
  problems: ConfigProblem[],
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    problems.push(errorAt(path, `expected a string, got ${describe(value)}`));
    return undefined;
  }
  const match = options.find((option) => option === value);
  if (match === undefined) {
    problems.push(errorAt(path, `must be one of ${options.join(", ")}`));
    return undefined;
  }
  return match;
}

/** Only the terminal view exists in stage A; `chat` is named here so its problem reads as such. */
function taskView(value: unknown, path: string, problems: ConfigProblem[]): TaskView | undefined {
  const view = choiceField(TaskView.options, value, path, problems);
  if (view === "chat") {
    problems.push(
      errorAt(path, "the chat view arrives with stage B; a task opens in the terminal"),
    );
    return undefined;
  }
  return view;
}

/** A profile a setting may name: a profile that is in the file and valid, so a launch can use it. */
function profileRef(
  value: unknown,
  path: string,
  problems: ConfigProblem[],
  profileIds: ReadonlySet<string>,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    problems.push(errorAt(path, `expected a string, got ${describe(value)}`));
    return undefined;
  }
  if (!profileIds.has(value)) {
    problems.push(errorAt(path, `there is no valid profile with id "${value}"`));
    return undefined;
  }
  return value;
}

/** A model is validated against the agent of its own table; alone it only has to be a model id. */
function modelField(
  value: unknown,
  path: string,
  agent: AgentKind | undefined,
  problems: ConfigProblem[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    problems.push(errorAt(path, `expected a string, got ${describe(value)}`));
    return undefined;
  }
  const issues =
    agent === undefined || supportsModel(agent)
      ? MODEL_ID.test(value)
        ? []
        : ["the model is not a valid native model id (letters, digits, . _ : / @ + -)"]
      : [`${agent} has no model flag on its launch command`];
  for (const issue of issues) problems.push(errorAt(path, issue));
  return issues.length === 0 ? value : undefined;
}

/** An absolute path, or one under `~`; the server expands `~` when it creates a worktree there. */
function worktreeRoot(value: unknown, path: string, problems: ConfigProblem[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    problems.push(errorAt(path, `expected a string, got ${describe(value)}`));
    return undefined;
  }
  if (value.startsWith("~/") || isAbsolute(value)) return value;
  problems.push(errorAt(path, "the worktree root must be an absolute path or start with ~/"));
  return undefined;
}

/** A prefix `<branch-prefix><slug>` has to stay usable as a branch name. */
function branchPrefix(value: unknown, path: string, problems: ConfigProblem[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    problems.push(errorAt(path, `expected a string, got ${describe(value)}`));
    return undefined;
  }
  const problem = branchPrefixProblem(value);
  if (problem !== undefined) {
    problems.push(errorAt(path, problem));
    return undefined;
  }
  return value;
}

function branchPrefixProblem(prefix: string): string | undefined {
  // oxlint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\s\u0000-\u001f\u007f~^:?*[\\]/.test(prefix))
    return "a branch prefix may not hold whitespace or any of ~ ^ : ? * [ \\";
  if (prefix.includes("..") || prefix.includes("//") || prefix.includes("@{"))
    return 'a branch prefix may not hold "..", "//" or "@{"';
  if (/^[/.-]/.test(prefix)) return "a branch prefix may not start with /, . or -";
  return undefined;
}

function timeoutSeconds(
  value: unknown,
  path: string,
  problems: ConfigProblem[],
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    problems.push(errorAt(path, "the timeout must be a whole number of seconds, at least 1"));
    return undefined;
  }
  return value;
}

function projectPathProblem(path: string): string | undefined {
  if (!isAbsolute(path)) return "a project key must be an absolute repository path";
  if (path.endsWith(sep) || normalize(path) !== path)
    return "a project key must match the added path exactly, without a trailing separator or . and .. segments";
  return undefined;
}

function profileRevision(profile: Omit<LaunchProfile, "revision">): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        profile.id,
        profile.name,
        profile.agent,
        profile.model,
        profile.provider,
        profile.env.map((ref) => [ref.targetName, ref.fromEnv]),
      ]),
    )
    .digest("hex")
    .slice(0, 12);
}

function validBindings(keys: unknown, problems: ConfigProblem[]): Map<ActionId, FileBinding> {
  const bindings = new Map<ActionId, FileBinding>();
  const table = isTable(keys) ? keys["bindings"] : undefined;
  if (table === undefined) return bindings;
  if (!isTable(table)) {
    problems.push(errorAt(BINDINGS_PATH, `expected a table, got ${describe(table)}`));
    return bindings;
  }
  for (const [key, value] of Object.entries(table)) {
    const path = `${BINDINGS_PATH}.${key}`;
    const action = ActionId.safeParse(key);
    if (!action.success) {
      problems.push(errorAt(path, `unknown action "${key}"`));
      continue;
    }
    if (typeof value !== "string") {
      problems.push(errorAt(path, `expected a string, got ${describe(value)}`));
      continue;
    }
    if (value === "") {
      bindings.set(action.data, { text: null });
      continue;
    }
    try {
      bindings.set(action.data, { text: value, chord: parseChord(value) });
    } catch (error) {
      problems.push(errorAt(path, messageOf(error)));
    }
  }
  return bindings;
}

/**
 * Chords the browser handles before the page sees them (design.md "Keyboard"): Ctrl or Cmd
 * with W, T or N (Ctrl+Shift+T included) and Ctrl+Tab. Alt gets a chord past the browser, so
 * `alt+ctrl+w` stays ours. A binding fires after the prefix, as its own key press without the
 * prefix's modifiers, so only the binding's own modifiers can make it browser-owned.
 */
function isBrowserOwned(chord: Chord): boolean {
  if (chord.alt) return false;
  if (chord.code === "Tab") return chord.ctrl;
  return (chord.ctrl || chord.meta) && ["KeyW", "KeyT", "KeyN"].includes(chord.code);
}

function tomlProblem(error: unknown): ConfigProblem {
  if (error instanceof TomlError) {
    const reason = error.message.split("\n", 1)[0]?.replace(/^Invalid TOML document: /, "");
    return errorAt("", `invalid TOML at line ${error.line}, column ${error.column}: ${reason}`);
  }
  return errorAt("", `invalid TOML: ${messageOf(error)}`);
}

function errorAt(path: string, message: string): ConfigProblem {
  return { severity: "error", path, message };
}

function isTable(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

function describe(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (isTable(value)) return "a table";
  if (value instanceof Date) return "a date";
  return typeof value === "string" ? "a string" : `a ${typeof value}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
