import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";

/**
 * User configuration, read by the server from `$CORRAL_CONFIG_DIR/config.toml`, else
 * `$XDG_CONFIG_HOME/corral/config.toml`, else `~/.config/corral/config.toml`, and pushed to
 * every client. The server owns the file so that every client (desktop, browser, later
 * mobile) gets the same bindings.
 *
 * ```toml
 * [keys]
 * prefix = "alt+a"
 *
 * [keys.bindings]   # action = chord after the prefix; "" unbinds
 * new-agent = "a"
 *
 * [keys.direct]     # direct commands; `mod` is Cmd on macOS, Ctrl elsewhere
 * new-task = "mod+n"
 *
 * [profiles.gateway]  # a launch profile; see docs/agent-profiles.md
 * name = "Claude via gateway"
 * agent = "claude"
 * model = "claude-sonnet-4-5"
 * env = [{ targetName = "ANTHROPIC_AUTH_TOKEN", fromEnv = "GATEWAY_TOKEN" }]
 *
 * [tasks]             # what a new task starts with
 * workspace = "new-worktree"
 * branch-prefix = "corral/"
 * view = "chat"       # chat (default) | terminal; chat needs a driver
 *
 * [naming]            # title generation; absent means seed titles
 * agent = "claude"
 * model = "claude-haiku-4-5"
 *
 * [agents.pi]         # per agent; no per-project layer
 * enabled = true      # false hides it from every picker and refuses a new launch
 * command = "/opt/pi/bin/pi"  # an absolute path overriding the PATH lookup
 *
 * [editor]            # what a local file link in chat opens; no per-project layer
 * command = "code --goto {file}:{line}"  # else $VISUAL, else $EDITOR, run in a terminal
 *
 * [projects."/home/me/code/app"]  # the same keys, for that project only
 * workspace = "main-worktree"
 * ```
 */

/** The agent CLIs Corral can launch. */
export const AgentKind = z.enum(["claude", "codex", "pi", "opencode"]);
export type AgentKind = z.infer<typeof AgentKind>;

/** A native model id passed as one argv value, shared by config, launches and UI validation. */
export const NATIVE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

/** What a new-session picker may offer for each agent; the server validates with the same table. */
export interface AgentLaunchCapability {
  readonly model: boolean;
  readonly provider: boolean;
  readonly providerRequiresModel: boolean;
}

export const AGENT_LAUNCH_CAPABILITY = {
  claude: { model: true, provider: false, providerRequiresModel: false },
  codex: { model: true, provider: true, providerRequiresModel: false },
  pi: { model: true, provider: true, providerRequiresModel: true },
  opencode: { model: false, provider: false, providerRequiresModel: false },
} as const satisfies Readonly<Record<AgentKind, AgentLaunchCapability>>;

/** Every action a key can run, also listed in the command palette. */
export const ActionId = z.enum([
  "new-terminal",
  "new-agent",
  "stop-session",
  "restart-session",
  "rename-session",
  "remove-session",
  "next-session",
  "previous-session",
  "abort-turn",
  "change-model",
  "change-reasoning",
  "switch-view",
  "changes",
  "close-tab",
  "toggle-companion",
  "move-tab",
  "focus-companion",
  "session-1",
  "session-2",
  "session-3",
  "session-4",
  "session-5",
  "session-6",
  "session-7",
  "session-8",
  "session-9",
  "new-task",
  "remove-task",
  "rename-task",
  "settle-task",
  "find-task",
  "next-task",
  "previous-task",
  "sidebar-mode",
  "toggle-sidebar",
  "focus-sidebar",
  "add-project",
  "board",
  "jump-blocked",
  "command-palette",
  "settings",
]);
export type ActionId = z.infer<typeof ActionId>;

/** Chords after the prefix, in the syntax of `parseChord` (`keymap.ts`). */
export const DEFAULT_PREFIX = "alt+a";
export const DEFAULT_BINDINGS: Readonly<Record<ActionId, string>> = {
  "new-terminal": "c",
  "new-agent": "s",
  "stop-session": "x",
  "restart-session": "r",
  "rename-session": "shift+r",
  "remove-session": "shift+x",
  "next-session": "n",
  "previous-session": "p",
  "abort-turn": ".",
  "change-model": "m",
  "change-reasoning": "shift+m",
  "switch-view": "v",
  changes: "shift+c",
  "close-tab": "q",
  "toggle-companion": "shift+b",
  "move-tab": "shift+o",
  "focus-companion": "shift+w",
  "session-1": "1",
  "session-2": "2",
  "session-3": "3",
  "session-4": "4",
  "session-5": "5",
  "session-6": "6",
  "session-7": "7",
  "session-8": "8",
  "session-9": "9",
  "new-task": "t",
  "remove-task": "shift+t",
  "rename-task": "e",
  "settle-task": "d",
  "find-task": "f",
  "next-task": "j",
  "previous-task": "k",
  "sidebar-mode": "l",
  "toggle-sidebar": "\\",
  "focus-sidebar": "w",
  "add-project": "shift+p",
  board: "b",
  "jump-blocked": "g",
  "command-palette": "space",
  settings: "o",
};

/**
 * A direct command: it fires without the prefix. The three creation commands mirror T3's
 * desktop/web semantics (`docs/layout.md`). A chord is config syntax understood by
 * `parseModChord`; `mod` is Command on macOS and Control elsewhere.
 */
export const DirectActionId = z.enum(["new-task", "new-task-in-project", "new-task-no-project"]);
export type DirectActionId = z.infer<typeof DirectActionId>;

export const DEFAULT_DIRECT_BINDINGS: Readonly<Record<DirectActionId, string>> = {
  "new-task": "mod+n",
  "new-task-in-project": "mod+shift+n",
  "new-task-no-project": "mod+alt+n",
};

/** What each direct command opens, for Settings and the browser-owned warning. */
export const DIRECT_ACTION_LABELS: Readonly<Record<DirectActionId, string>> = {
  "new-task": "New task (choose a project)",
  "new-task-in-project": "New task in the current project",
  "new-task-no-project": "New task without a project",
};

/**
 * A server environment variable a profile hands to the agent. Only names: the value is read
 * from the server environment at launch and never stored, sent to a client or written to argv.
 */
export const EnvRef = z.object({
  /** Variable name in the agent's environment. */
  targetName: z.string(),
  /** Variable name in the server's environment the value comes from. */
  fromEnv: z.string(),
});
export type EnvRef = z.infer<typeof EnvRef>;

/**
 * A named launch profile from the config file: an agent and, where the agent supports it, a
 * native model/provider. Literal environment values remain private to the server. Instance
 * command, args and enabled are descriptors; launch integration is not yet complete.
 */
export const LaunchProfile = z.object({
  id: z.string(),
  name: z.string(),
  agent: AgentKind,
  model: z.string().nullable(),
  provider: z.string().nullable(),
  env: z.array(EnvRef),
  /** Literal entry names only; their values never leave the server. */
  literalEnvNames: z.array(z.string()).optional(),
  command: z.string().nullable().optional(),
  args: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  /** Content revision of this definition, so a session can say which one it was launched with. */
  revision: z.string(),
});
export type LaunchProfile = z.infer<typeof LaunchProfile>;

/** Where an effective value came from: decision 17's layers. */
export const SettingSource = z.enum(["default", "global", "project"]);
export type SettingSource = z.infer<typeof SettingSource>;

/**
 * `[agents.<kind>]`: what Corral offers and runs for one agent. It has no per-project layer — an
 * agent is a property of the machine, not of a repository — so a value is either the built-in
 * default or the file's global one. Launch profiles stay the place for a model, a provider and
 * environment references (`docs/agent-profiles.md`); this table does not repeat them.
 */
export const AgentSetting = z.object({
  /** False hides the agent from every picker and refuses a new launch of it. */
  enabled: sourced(z.boolean()),
  /**
   * The executable a launch runs. Built in it is the agent's own name, looked up on the server's
   * `PATH`; the file may name an absolute path instead. Naming runs use it too.
   */
  command: sourced(z.string()),
});
export type AgentSetting = z.infer<typeof AgentSetting>;

/** Every agent's setting, keyed by kind. */
export type AgentSettings = Readonly<Record<AgentKind, AgentSetting>>;

/** The command a launch of `kind` runs: the configured override, else the agent's own name. */
export function agentCommand(config: ClientConfig, kind: AgentKind): string {
  return config.agents[kind].command.value;
}

/** Whether the agent is offered: `[agents.<kind>].enabled`, true by default. */
export function agentEnabled(config: ClientConfig, kind: AgentKind): boolean {
  return config.agents[kind].enabled.value;
}

/**
 * `[editor]`: the command a local file link in chat opens. Like `[agents.<kind>]` it describes the
 * machine, not a repository, so it has no per-project layer. Empty means "not configured": the
 * server falls back to `$VISUAL`, then `$EDITOR`, and a file link without any of them is refused
 * with `EDITOR_UNSET` (`docs/agent-profiles.md`).
 */
export const EditorSetting = z.object({
  /** A command line, split like a shell would; `{file}`, `{line}` and `{column}` are filled in. */
  command: sourced(z.string()),
});
export type EditorSetting = z.infer<typeof EditorSetting>;

/** The editor before the file: nothing configured, so `$VISUAL`/`$EDITOR` decide. */
export function defaultEditorSetting(): EditorSetting {
  return { command: builtin("") };
}

/** The command a file link runs: `[editor] command`, or the empty string for the environment. */
export function editorCommand(config: ClientConfig): string {
  return config.editor.command.value;
}

/**
 * What this server host has for one agent, for Settings. It is a fact about the machine and the
 * build, not a configured value: `found` comes from the server's executable lookup and
 * `chatDriver` from the same list `chat.capabilities` reports.
 */
export const AgentAvailability = z.object({
  kind: AgentKind,
  /** Whether the effective command (`[agents.<kind>].command`, else the agent's name) is executable. */
  found: z.boolean(),
  /** Whether this server build can show the agent as chat (`chat.capabilities`). */
  chatDriver: z.boolean(),
});
export type AgentAvailability = z.infer<typeof AgentAvailability>;

/** How a new task gets its workspace (`design.md`, **Domain model → Task → Workspace**). */
export const WorkspaceMode = z.enum(["main-worktree", "new-worktree"]);
export type WorkspaceMode = z.infer<typeof WorkspaceMode>;

/** Whether branch and worktree names come from the title or from the naming request (decision 16). */
export const SlugMode = z.enum(["title", "generated"]);
export type SlugMode = z.infer<typeof SlugMode>;

/** The view a task's primary agent opens in (decision 5). */
export const TaskView = z.enum(["terminal", "chat"]);
export type TaskView = z.infer<typeof TaskView>;

function sourced<T extends z.ZodType>(value: T) {
  return z.object({ value, source: SettingSource });
}

/**
 * What task creation and the new-task composer use for one project, with the layer each value
 * came from. The server resolves it (built-in default → `[tasks]` → `[projects."<path>"]`), so
 * clients render it instead of looking layers up themselves. `profile` wins over `agent` when
 * both are set; `model` overrides the profile's model, as it does on `sessions.start`.
 */
export const ResolvedTaskSettings = z.object({
  agent: sourced(AgentKind.nullable()),
  profile: sourced(z.string().nullable()),
  model: sourced(z.string().nullable()),
  workspace: sourced(WorkspaceMode),
  /** An absolute path, or `~`-relative as written; the server expands `~` when it uses it. */
  worktreeRoot: sourced(z.string()),
  branchPrefix: sourced(z.string()),
  slugMode: sourced(SlugMode),
  view: sourced(TaskView),
});
export type ResolvedTaskSettings = z.infer<typeof ResolvedTaskSettings>;

/**
 * `[naming]`: the launch profile or agent and model that generates task titles (decision 16),
 * and how long Corral waits for it. Naming has no per-project layer: one setting for the server.
 */
export const NamingSettings = z.object({
  profile: sourced(z.string().nullable()),
  agent: sourced(AgentKind.nullable()),
  model: sourced(z.string().nullable()),
  timeoutSeconds: sourced(z.number()),
});
export type NamingSettings = z.infer<typeof NamingSettings>;

/** The default wait for a naming request, in seconds. */
export const DEFAULT_NAMING_TIMEOUT_SECONDS = 8;

/** Whether `[naming]` names something to run; empty means seed titles only (decision 16). */
export function namingConfigured(naming: NamingSettings): boolean {
  return naming.profile.value !== null || naming.agent.value !== null;
}

function builtin<T>(value: T): { value: T; source: SettingSource } {
  return { value, source: "default" };
}

/** The agents before the file: every one offered, each launched by its own name on `PATH`. */
export function defaultAgentSettings(): Record<AgentKind, AgentSetting> {
  return {
    claude: { enabled: builtin(true), command: builtin<string>("claude") },
    codex: { enabled: builtin(true), command: builtin<string>("codex") },
    pi: { enabled: builtin(true), command: builtin<string>("pi") },
    opencode: { enabled: builtin(true), command: builtin<string>("opencode") },
  };
}

/** The naming defaults before the file: nothing to run, the standard timeout. */
export function defaultNamingSettings(): NamingSettings {
  return {
    profile: builtin<string | null>(null),
    agent: builtin<AgentKind | null>(null),
    model: builtin<string | null>(null),
    timeoutSeconds: builtin(DEFAULT_NAMING_TIMEOUT_SECONDS),
  };
}

/** Corral's default worktree root: `<data dir>/worktrees`, where the server keeps its data. */
export function defaultWorktreeRoot(dataDir: string): string {
  if (dataDir === "") return "";
  const separator = dataDir.includes("\\") && !dataDir.includes("/") ? "\\" : "/";
  const base = dataDir.endsWith(separator) ? dataDir.slice(0, -separator.length) : dataDir;
  return `${base}${separator}worktrees`;
}

/**
 * The configuration before the file: keys, and the built-in layer of every task and naming
 * value. This is the only definition of Corral's defaults; the server passes its data dir, and
 * a client that has no state yet passes `""` (it renders defaults only once loaded).
 */
export function defaultClientConfig(dataDir: string): ClientConfig {
  return {
    keys: {
      prefix: DEFAULT_PREFIX,
      bindings: { ...DEFAULT_BINDINGS },
      direct: { ...DEFAULT_DIRECT_BINDINGS },
    },
    tasks: {
      agent: builtin<AgentKind | null>(null),
      profile: builtin<string | null>(null),
      model: builtin<string | null>(null),
      workspace: builtin<WorkspaceMode>("main-worktree"),
      worktreeRoot: builtin(defaultWorktreeRoot(dataDir)),
      branchPrefix: builtin(""),
      slugMode: builtin<SlugMode>("title"),
      view: builtin<TaskView>("chat"),
    },
    naming: defaultNamingSettings(),
    agents: defaultAgentSettings(),
    editor: defaultEditorSetting(),
    projects: {},
  };
}

/** The effective configuration: defaults with the file's valid entries applied. */
export const ClientConfig = z.object({
  keys: z.object({
    prefix: z.string(),
    /** Every action; `null` when the user unbound it. */
    bindings: z.record(ActionId, z.string().nullable()),
    /**
     * Direct commands, `null` when unbound. The default keeps a daemon from before this table
     * answering with the accepted creation shortcuts.
     */
    direct: z
      .record(DirectActionId, z.string().nullable())
      .default(() => ({ ...DEFAULT_DIRECT_BINDINGS })),
  }),
  /** The `[tasks]` values every project without an override gets. */
  tasks: ResolvedTaskSettings,
  naming: NamingSettings,
  /**
   * `[agents.<kind>]`: every agent's `enabled` and `command`, with the layer each came from. The
   * default keeps "absent means every agent offered by its own name" one definition for a
   * protocol 9 daemon from before this table existed, like `Session.view`'s default.
   */
  agents: z.record(AgentKind, AgentSetting).default(() => defaultAgentSettings()),
  /**
   * `[editor]`: the command a local file link opens. The default keeps "absent means the server's
   * `$VISUAL`/`$EDITOR` decide" one definition for a protocol 10 daemon from before the table
   * existed, like `agents` above.
   */
  editor: EditorSetting.default(() => defaultEditorSetting()),
  /**
   * `[projects."<absolute repository path>"]` resolved against `[tasks]`, keyed by the canonical
   * repository path: the real path when it exists (so a symlinked key matches `Project.path`),
   * else the key as written. A project without an entry uses `tasks`.
   */
  projects: z.record(z.string(), ResolvedTaskSettings),
});
export type ClientConfig = z.infer<typeof ClientConfig>;

/** The effective task settings for `path`: its own table, else the global `[tasks]` values. */
export function taskSettingsFor(config: ClientConfig, path: string): ResolvedTaskSettings {
  return config.projects[path] ?? config.tasks;
}

/**
 * Something wrong in the file. Each problem drops only the entry it names; the rest of the
 * file still applies. `warning`s apply the entry anyway (e.g. a chord a browser keeps for
 * itself, design.md "Keyboard").
 */
export const ConfigProblem = z.object({
  severity: z.enum(["error", "warning"]),
  /** Dotted path in the file, e.g. `keys.bindings.new-agent`; empty for the whole file. */
  path: z.string(),
  message: z.string(),
});
export type ConfigProblem = z.infer<typeof ConfigProblem>;

export const ConfigState = z.object({
  /** Absolute path of the file the server reads; it may not exist. */
  path: z.string(),
  /**
   * Whether the file exists: false when it is missing (ENOENT/ENOTDIR), true otherwise —
   * including a file that exists but cannot be read, which also reports a problem. Absent from a
   * daemon from before this field: a client treats that as unknown.
   */
  exists: z.boolean().optional(),
  config: ClientConfig,
  /** The profiles whose every field is valid; an invalid profile is dropped whole. */
  profiles: z.array(LaunchProfile),
  /**
   * What this host has for each agent: whether it is found, and whether it has a chat driver.
   * Empty for a protocol 9 daemon from before the list existed; Settings then says it is unknown.
   */
  agents: z.array(AgentAvailability).default([]),
  problems: z.array(ConfigProblem),
});
export type ConfigState = z.infer<typeof ConfigState>;

export const configContract = {
  /** Yields the state now and again whenever the file changes on disk. */
  watch: oc.output(eventIterator(ConfigState)),
};
