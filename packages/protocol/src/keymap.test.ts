import * as fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import {
  formatChord,
  formatModChord,
  hasCommandModifier,
  matchesChord,
  matchesModChord,
  parseChord,
  parseModChord,
} from "./keymap.ts";

const keyEvent = (
  code: string,
  modifiers: Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>> = {},
) => ({
  code,
  ctrlKey: modifiers.ctrl ?? false,
  altKey: modifiers.alt ?? false,
  shiftKey: modifiers.shift ?? false,
  metaKey: modifiers.meta ?? false,
});

describe("parseChord", () => {
  test("binds to the physical key, so alt+a matches on the Russian layout too", () => {
    const prefix = parseChord("alt+a");
    // On ЙЦУКЕН the same key produces key "ф" but code stays "KeyA".
    expect(matchesChord({ ...keyEvent("KeyA", { alt: true }) }, prefix)).toBe(true);
  });

  test("the default toggle-sidebar chord is the backslash key", () => {
    const chord = parseChord("\\");
    expect(matchesChord(keyEvent("Backslash"), chord)).toBe(true);
    expect(matchesChord(keyEvent("Backslash", { shift: true }), chord)).toBe(false);
    expect(formatChord(chord)).toBe("\\");
  });

  test("the abort turn chord is the period key, written prefix .", () => {
    const chord = parseChord(".");
    expect(matchesChord(keyEvent("Period"), chord)).toBe(true);
    expect(formatChord(chord)).toBe(".");
  });

  test("requires exactly the listed modifiers", () => {
    const prefix = parseChord("alt+a");
    expect(matchesChord(keyEvent("KeyA"), prefix)).toBe(false);
    expect(matchesChord(keyEvent("KeyA", { alt: true, shift: true }), prefix)).toBe(false);
  });

  test("rejects unknown modifiers and keys with the offending text", () => {
    expect(() => parseChord("hyper+a")).toThrow('unknown modifier "hyper" in "hyper+a"');
    expect(() => parseChord("alt+ä")).toThrow('unknown key "ä" in "alt+ä"');
  });

  const chordText = fc
    .tuple(
      fc.subarray(["ctrl", "alt", "shift", "meta"]),
      fc.constantFrom("a", "z", "0", "9", "f1", "f12", "enter", "esc", "minus", "slash", "\\", "."),
    )
    .map(([modifiers, key]) => [...modifiers, key].join("+"));

  test("formatting a parsed chord gives back the same chord", () => {
    fc.assert(
      fc.property(chordText, (text) => {
        expect(parseChord(formatChord(parseChord(text)))).toEqual(parseChord(text));
      }),
    );
  });
});

describe("direct command chords", () => {
  test("mod is Command on macOS and Control elsewhere, by physical key", () => {
    const chord = parseModChord("mod+shift+n");
    expect(matchesModChord(keyEvent("KeyN", { ctrl: true, shift: true }), chord, "other")).toBe(
      true,
    );
    expect(matchesModChord(keyEvent("KeyN", { meta: true, shift: true }), chord, "mac")).toBe(true);
    expect(matchesModChord(keyEvent("KeyN", { meta: true, shift: true }), chord, "other")).toBe(
      false,
    );
    expect(matchesModChord(keyEvent("KeyN", { ctrl: true, shift: true }), chord, "mac")).toBe(
      false,
    );
  });

  test("all modifiers must match exactly", () => {
    const chord = parseModChord("mod+alt+n");
    expect(matchesModChord(keyEvent("KeyN", { ctrl: true, alt: true }), chord, "other")).toBe(true);
    expect(matchesModChord(keyEvent("KeyN", { ctrl: true }), chord, "other")).toBe(false);
    expect(
      matchesModChord(keyEvent("KeyN", { ctrl: true, alt: true, shift: true }), chord, "other"),
    ).toBe(false);
  });

  test("a command chord must carry a modifier", () => {
    expect(hasCommandModifier(parseModChord("mod+n"))).toBe(true);
    expect(hasCommandModifier(parseModChord("alt+n"))).toBe(true);
    expect(hasCommandModifier(parseModChord("shift+n"))).toBe(false);
    expect(hasCommandModifier(parseModChord("n"))).toBe(false);
  });

  test("mod cannot be combined with an explicit ctrl or meta", () => {
    expect(() => parseModChord("mod+ctrl+n")).toThrow('"mod" already means ctrl or meta');
    expect(() => parseModChord("mod+meta+n")).toThrow('"mod" already means ctrl or meta');
  });

  test("the same text formats back", () => {
    for (const text of ["mod+n", "mod+shift+n", "mod+alt+n", "ctrl+shift+f12", "alt+up"]) {
      expect(formatModChord(parseModChord(text))).toBe(text);
    }
  });
});
