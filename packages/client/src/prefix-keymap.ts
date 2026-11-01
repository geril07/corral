import { ActionId, type ClientConfig } from "@corral/protocol/config";
import { matchesChord, parseChord, type Chord } from "@corral/protocol/keymap";

export interface KeyInput {
  code: string;
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

export interface PrefixKeymap<Action> {
  prefix: Chord;
  /** Chords that follow the prefix. */
  bindings: readonly { chord: Chord; action: Action }[];
}

/** `bindings` maps config chord syntax (`c`, `shift+n`) to the action it runs after the prefix. */
export function createPrefixKeymap<Action>(
  prefix: string,
  bindings: Readonly<Record<string, Action>>,
): PrefixKeymap<Action> {
  return {
    prefix: parseChord(prefix),
    bindings: Object.entries(bindings).map(([chord, action]) => ({
      chord: parseChord(chord),
      action,
    })),
  };
}

/** The effective config as a keymap; an action the user unbound has no key. */
export function createConfigKeymap(config: ClientConfig): PrefixKeymap<ActionId> {
  const bindings: Record<string, ActionId> = {};
  for (const action of ActionId.options) {
    const chord: unknown = config.keys.bindings[action];
    // A same-version daemon from before this action sends no entry; skip it instead of feeding
    // `undefined` to `parseChord` (the client's store fills the defaults, this is the last guard).
    if (typeof chord === "string") bindings[chord] = action;
  }
  return createPrefixKeymap(config.keys.prefix, bindings);
}

export interface PrefixOutcome<Action> {
  armed: boolean;
  /** The key was part of prefix handling; the caller must not pass it on to the terminal. */
  handled: boolean;
  action?: Action;
}

const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta"]);

/**
 * One key press in prefix mode. Outside it only the prefix chord is taken. Once armed, the next
 * key is taken whatever it is: a bound key runs its action, the prefix chord or any other key
 * just disarms. Modifier presses and IME composition are never touched.
 */
export function resolvePrefixKey<Action>(
  keymap: PrefixKeymap<Action>,
  armed: boolean,
  event: KeyInput,
): PrefixOutcome<Action> {
  if (event.isComposing || MODIFIER_KEYS.has(event.key)) return { armed, handled: false };
  if (!armed) {
    return matchesChord(event, keymap.prefix)
      ? { armed: true, handled: true }
      : { armed: false, handled: false };
  }
  const binding = keymap.bindings.find(({ chord }) => matchesChord(event, chord));
  return binding
    ? { armed: false, handled: true, action: binding.action }
    : { armed: false, handled: true };
}
