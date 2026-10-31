import { DEFAULT_BINDINGS, defaultClientConfig, type ClientConfig } from "@corral/protocol/config";
import { parseChord } from "@corral/protocol/keymap";
import { expect, test } from "vite-plus/test";
import {
  createConfigKeymap,
  createPrefixKeymap,
  resolvePrefixKey,
  type KeyInput,
} from "./prefix-keymap.ts";

const keymap = createPrefixKeymap("alt+a", { c: "create", x: "close", "shift+n": "next-shifted" });

function key(code: string, init: Partial<KeyInput> = {}): KeyInput {
  return {
    code,
    key: code.startsWith("Key") ? code.slice(3).toLowerCase() : code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    isComposing: false,
    ...init,
  };
}
const prefix = key("KeyA", { key: "ф", altKey: true });

test("the prefix chord arms, matched by physical key so another layout works", () => {
  expect(resolvePrefixKey(keymap, false, prefix)).toEqual({ armed: true, handled: true });
});

test("outside prefix mode every other key is left to the terminal", () => {
  expect(resolvePrefixKey(keymap, false, key("KeyC"))).toEqual({ armed: false, handled: false });
  expect(resolvePrefixKey(keymap, false, key("KeyA"))).toEqual({ armed: false, handled: false });
});

test("a bound key after the prefix runs its action and disarms", () => {
  expect(resolvePrefixKey(keymap, true, key("KeyC"))).toEqual({
    armed: false,
    handled: true,
    action: "create",
  });
  expect(resolvePrefixKey(keymap, true, key("KeyN", { shiftKey: true }))).toMatchObject({
    action: "next-shifted",
  });
});

test("an unbound key or the prefix again just disarms and is swallowed", () => {
  expect(resolvePrefixKey(keymap, true, key("KeyQ"))).toEqual({ armed: false, handled: true });
  expect(resolvePrefixKey(keymap, true, prefix)).toEqual({ armed: false, handled: true });
});

test("modifier presses and IME composition never change state", () => {
  expect(resolvePrefixKey(keymap, true, key("ShiftLeft", { key: "Shift" }))).toEqual({
    armed: true,
    handled: false,
  });
  expect(resolvePrefixKey(keymap, false, key("AltLeft", { key: "Alt", altKey: true }))).toEqual({
    armed: false,
    handled: false,
  });
  expect(resolvePrefixKey(keymap, true, key("KeyC", { isComposing: true }))).toEqual({
    armed: true,
    handled: false,
  });
});

test("the config builds the keymap and leaves an unbound action without a key", () => {
  const config: ClientConfig = {
    ...defaultClientConfig(""),
    keys: {
      prefix: "ctrl+b",
      bindings: { ...DEFAULT_BINDINGS, "new-agent": null, board: "q" },
    },
  };
  const fromConfig = createConfigKeymap(config);

  expect(fromConfig.prefix).toEqual(parseChord("ctrl+b"));
  expect(fromConfig.bindings).toContainEqual({
    chord: parseChord("c"),
    action: "new-terminal",
  });
  expect(fromConfig.bindings).toContainEqual({ chord: parseChord("q"), action: "board" });
  expect(fromConfig.bindings.some(({ action }) => action === "new-agent")).toBe(false);
});

test("a keymap from config dispatches the action bound in the file", () => {
  const config: ClientConfig = {
    ...defaultClientConfig(""),
    keys: { prefix: "alt+a", bindings: { ...DEFAULT_BINDINGS, "new-agent": "a" } },
  };
  const fromConfig = createConfigKeymap(config);

  expect(resolvePrefixKey(fromConfig, true, key("KeyA"))).toEqual({
    armed: false,
    handled: true,
    action: "new-agent",
  });
  expect(resolvePrefixKey(fromConfig, true, key("KeyS"))).toEqual({ armed: false, handled: true });
});
