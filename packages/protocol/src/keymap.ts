export interface Chord {
  /** `KeyboardEvent.code`: the physical key, so bindings survive layout switches. */
  readonly code: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

const MODIFIERS = ["ctrl", "alt", "shift", "meta"] as const;

const NAMED_CODES: Readonly<Record<string, string>> = {
  enter: "Enter",
  tab: "Tab",
  esc: "Escape",
  space: "Space",
  backspace: "Backspace",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  minus: "Minus",
  equal: "Equal",
  comma: "Comma",
  slash: "Slash",
  ".": "Period",
  backquote: "Backquote",
  // The key itself, as `toggle-sidebar` defaults to it; formatting gives the same text back.
  "\\": "Backslash",
};

/** Parses config syntax like `alt+a`, `ctrl+shift+enter`, `f12`. */
export function parseChord(text: string): Chord {
  const parts = text.toLowerCase().split("+");
  const key = parts.pop();
  if (!key) throw new Error(`empty chord: "${text}"`);
  const modifiers = new Set(parts);
  for (const modifier of modifiers) {
    if (!(MODIFIERS as readonly string[]).includes(modifier)) {
      throw new Error(`unknown modifier "${modifier}" in "${text}"`);
    }
  }
  return {
    code: keyToCode(key, text),
    ctrl: modifiers.has("ctrl"),
    alt: modifiers.has("alt"),
    shift: modifiers.has("shift"),
    meta: modifiers.has("meta"),
  };
}

export function formatChord(chord: Chord): string {
  const modifiers = MODIFIERS.filter((modifier) => chord[modifier]);
  return [...modifiers, codeToKey(chord.code)].join("+");
}

/** Which key `mod` means: Command on macOS, Control elsewhere (`ux.md`, **Keys**). */
export type ModifierPlatform = "mac" | "other";

/**
 * A direct command chord: it fires without the prefix, so it carries the platform's `mod` key
 * (`mod+n` is Cmd+N on macOS and Ctrl+N elsewhere) instead of naming ctrl or meta itself.
 */
export interface ModChord {
  readonly code: string;
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

/**
 * Parses config syntax for a direct command, adding `mod` to the prefix chord's modifiers.
 * `mod` and an explicit ctrl/meta cannot be combined: that would make the chord mean two
 * different things on the two platforms.
 */
export function parseModChord(text: string): ModChord {
  const parts = text.toLowerCase().split("+");
  const key = parts.pop();
  if (!key) throw new Error(`empty chord: "${text}"`);
  const modifiers = new Set(parts);
  for (const modifier of modifiers) {
    if (modifier !== "mod" && !(MODIFIERS as readonly string[]).includes(modifier)) {
      throw new Error(`unknown modifier "${modifier}" in "${text}"`);
    }
  }
  const mod = modifiers.has("mod");
  if (mod && (modifiers.has("ctrl") || modifiers.has("meta"))) {
    throw new Error(`"mod" already means ctrl or meta in "${text}"`);
  }
  return {
    code: keyToCode(key, text),
    mod,
    ctrl: modifiers.has("ctrl"),
    alt: modifiers.has("alt"),
    shift: modifiers.has("shift"),
    meta: modifiers.has("meta"),
  };
}

export function formatModChord(chord: ModChord): string {
  const modifiers = (["mod", ...MODIFIERS] as const).filter((modifier) => chord[modifier]);
  return [...modifiers, codeToKey(chord.code)].join("+");
}

/** A direct command must take a modifier, or typing in the composer would run it. */
export function hasCommandModifier(chord: ModChord): boolean {
  return chord.mod || chord.ctrl || chord.alt || chord.meta;
}

/** Whether one press is the direct chord on `platform`; modifiers must match exactly. */
export function matchesModChord(
  event: ChordEvent,
  chord: ModChord,
  platform: ModifierPlatform,
): boolean {
  const modIsMeta = platform === "mac";
  const ctrl = chord.mod ? !modIsMeta : chord.ctrl;
  const meta = chord.mod ? modIsMeta : chord.meta;
  return (
    event.code === chord.code &&
    event.ctrlKey === ctrl &&
    event.altKey === chord.alt &&
    event.shiftKey === chord.shift &&
    event.metaKey === meta
  );
}

/** The part of a `KeyboardEvent` a binding reads; named so server code needs no DOM lib. */
export interface ChordEvent {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

export function matchesChord(event: ChordEvent, chord: Chord): boolean {
  return (
    event.code === chord.code &&
    event.ctrlKey === chord.ctrl &&
    event.altKey === chord.alt &&
    event.shiftKey === chord.shift &&
    event.metaKey === chord.meta
  );
}

function keyToCode(key: string, text: string): string {
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (/^f([1-9]|1[0-2])$/.test(key)) return key.toUpperCase();
  const named = NAMED_CODES[key];
  if (named) return named;
  throw new Error(`unknown key "${key}" in "${text}"`);
}

function codeToKey(code: string): string {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-2])$/.test(code)) return code.toLowerCase();
  const named = Object.entries(NAMED_CODES).find(([, value]) => value === code);
  if (named) return named[0];
  throw new Error(`no config name for code "${code}"`);
}
