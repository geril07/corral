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
 * ```
 */

/** The agent CLIs Corral can launch. */
export const AgentKind = z.enum(["claude", "codex", "pi", "opencode"]);
export type AgentKind = z.infer<typeof AgentKind>;

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
  "new-task",
  "remove-task",
  "settle-task",
  "find-task",
  "next-task",
  "previous-task",
  "add-project",
  "board",
  "jump-blocked",
  "command-palette",
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
  "new-task": "t",
  "remove-task": "shift+t",
  "settle-task": "d",
  "find-task": "f",
  "next-task": "j",
  "previous-task": "k",
  "add-project": "shift+p",
  board: "b",
  "jump-blocked": "g",
  "command-palette": "space",
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
 * native model/provider. It changes explicit launch choices only; it does not isolate the
 * agent from the server's other environment variables or from the agent's own credential files.
 */
export const LaunchProfile = z.object({
  id: z.string(),
  name: z.string(),
  agent: AgentKind,
  model: z.string().nullable(),
  provider: z.string().nullable(),
  env: z.array(EnvRef),
  /** Content revision of this definition, so a session can say which one it was launched with. */
  revision: z.string(),
});
export type LaunchProfile = z.infer<typeof LaunchProfile>;

/** The effective configuration: defaults with the file's valid entries applied. */
export const ClientConfig = z.object({
  keys: z.object({
    prefix: z.string(),
    /** Every action; `null` when the user unbound it. */
    bindings: z.record(ActionId, z.string().nullable()),
  }),
});
export type ClientConfig = z.infer<typeof ClientConfig>;

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
  config: ClientConfig,
  /** The profiles whose every field is valid; an invalid profile is dropped whole. */
  profiles: z.array(LaunchProfile),
  problems: z.array(ConfigProblem),
});
export type ConfigState = z.infer<typeof ConfigState>;

export const configContract = {
  /** Yields the state now and again whenever the file changes on disk. */
  watch: oc.output(eventIterator(ConfigState)),
};
