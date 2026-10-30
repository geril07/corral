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

/** Every action a key can run, also listed in the command palette. */
export const ActionId = z.enum([
  "new-terminal",
  "new-agent",
  "stop-session",
  "restart-session",
  "remove-session",
  "next-session",
  "previous-session",
  "new-task",
  "remove-task",
  "settle-task",
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
  "remove-session": "shift+x",
  "next-session": "n",
  "previous-session": "p",
  "new-task": "t",
  "remove-task": "shift+t",
  "settle-task": "d",
  "next-task": "j",
  "previous-task": "k",
  "add-project": "shift+p",
  board: "b",
  "jump-blocked": "g",
  "command-palette": "space",
};

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
  problems: z.array(ConfigProblem),
});
export type ConfigState = z.infer<typeof ConfigState>;

export const configContract = {
  /** Yields the state now and again whenever the file changes on disk. */
  watch: oc.output(eventIterator(ConfigState)),
};
