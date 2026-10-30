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
  period: "Period",
  slash: "Slash",
  backquote: "Backquote",
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
