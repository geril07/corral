import { defaultModelPolicy, type ModelPreferences } from "@corral/protocol/models";
import { expect, test } from "vite-plus/test";
import {
  acknowledgeSavedPreferences,
  adoptWatchedPreferences,
  initialSavedPreferences,
  watchedRevisionIsOld,
} from "./saved-preferences.ts";

const scope = { kind: "pi" as const, profileId: null };
const policy = defaultModelPolicy();
const saved = (revision: number, denyProvider?: string): ModelPreferences => ({
  scope,
  revision,
  policy: denyProvider
    ? { ...policy, deny: [{ type: "provider", provider: denyProvider }] }
    : policy,
});

test("an acknowledgement owns the save and a watch snapshot of its base is not a newer state", () => {
  const base = saved(10);
  let state = initialSavedPreferences(base);
  state = acknowledgeSavedPreferences(state, saved(20, "stub"));

  // The watch is still on the revision the save was based on: known old, never adopted.
  expect(adoptWatchedPreferences(state, saved(10, "other"))).toBe(state);
  expect(watchedRevisionIsOld(state, 10)).toBe(true);

  // The watch catches up on the acknowledgement and further changes are adopted again.
  state = adoptWatchedPreferences(state, saved(20, "stub"));
  expect(state.catchingUp).toBe(false);
  expect(state.current.revision).toBe(20);
  const external = adoptWatchedPreferences(state, saved(30));
  expect(external.current.revision).toBe(30);
});

test("an idle editor adopts an external revision whatever its opaque number is", () => {
  let state = initialSavedPreferences(saved(90));
  state = adoptWatchedPreferences(state, saved(4));
  expect(state.current.revision).toBe(4);
  expect(watchedRevisionIsOld(state, 90)).toBe(false);
});

test("a genuine undo after catch-up is adopted even when it repeats a superseded revision", () => {
  let state = initialSavedPreferences(saved(10));
  state = acknowledgeSavedPreferences(state, saved(20));
  state = adoptWatchedPreferences(state, saved(20));
  expect(adoptWatchedPreferences(state, saved(10)).current.revision).toBe(10);
});
