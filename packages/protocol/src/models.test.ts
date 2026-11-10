import { expect, test } from "vite-plus/test";
import {
  defaultModelPolicy,
  modelKey,
  modelScopeKey,
  modelVisible,
  orderModels,
  setModelVisible,
  setProviderVisible,
  toggleModelFavorite,
} from "./models.ts";

const one = { provider: "one", id: "a" };
const sibling = { provider: "one", id: "future" };
const other = { provider: "two", id: "a" };

test("provider allow rules include future models; exact model rules do not", () => {
  const empty = { ...defaultModelPolicy(), mode: "allow" as const };
  expect(modelVisible(empty, one)).toBe(false);
  const exact = setModelVisible(empty, one, true);
  expect(modelVisible(exact, one)).toBe(true);
  expect(modelVisible(exact, sibling)).toBe(false);
  expect(modelVisible(exact, other)).toBe(false);
  const provider = setProviderVisible(empty, "one", true);
  expect(modelVisible(provider, sibling)).toBe(true);
  expect(modelVisible(provider, other)).toBe(false);
});

test("provider and model exclusions win; favorites never bypass visibility", () => {
  let policy = setProviderVisible(defaultModelPolicy(), "one", false);
  policy = setModelVisible(policy, one, true);
  policy = toggleModelFavorite(policy, one);
  expect(policy.favorites).toEqual([one]);
  expect(modelVisible(policy, one)).toBe(false);
  expect(modelVisible(policy, sibling)).toBe(false);
  expect(modelVisible(policy, other)).toBe(true);
  policy = setProviderVisible(policy, "one", true);
  policy = setModelVisible(policy, one, false);
  expect(modelVisible(policy, one)).toBe(false);
  expect(modelVisible(policy, sibling)).toBe(true);
});

test("bulk show clears provider/model exclusions, not other providers or favorites", () => {
  let policy = setModelVisible(defaultModelPolicy(), other, false);
  policy = setModelVisible(policy, one, false);
  policy = setProviderVisible(policy, "one", false);
  const shown = setProviderVisible(policy, "one", true);
  expect(modelVisible(shown, one)).toBe(true);
  expect(modelVisible(shown, other)).toBe(false);
});

test("identities do not collide on delimiters, null providers, or same-id profiles of another tool", () => {
  expect(modelKey({ provider: "a/b", id: "c" })).not.toBe(modelKey({ provider: "a", id: "b/c" }));
  expect(modelKey({ provider: null, id: "a" })).not.toBe(modelKey({ provider: "null", id: "a" }));
  expect(modelScopeKey({ kind: "pi", profileId: "work" })).not.toBe(
    modelScopeKey({ kind: "opencode", profileId: "work" }),
  );
  expect(modelScopeKey({ kind: "pi", profileId: null })).not.toBe(
    modelScopeKey({ kind: "pi", profileId: "null" }),
  );
});

test("favorite order is independent of provider and ordinary model ordering", () => {
  const native = { provider: null, id: "native" };
  const policy = {
    ...defaultModelPolicy(),
    favorites: [other, one],
    providerOrder: ["two", "one"],
    modelOrder: [sibling, one],
  };
  const remaining = { provider: "two", id: "ordinary" };
  expect(orderModels(policy, [one, sibling, native, remaining, other])).toEqual([
    other,
    one,
    remaining,
    sibling,
    native,
  ]);
  expect(orderModels({ ...policy, favorites: [] }, [one, sibling, other])).toEqual([
    other,
    sibling,
    one,
  ]);
});

test("unlisted models stay in reported order within first-seen provider groups", () => {
  const unlisted = { provider: "new", id: "new" };
  const missing = { provider: "missing", id: "remembered" };
  const policy = { ...defaultModelPolicy(), modelOrder: [missing] };
  expect(orderModels(policy, [one, other, sibling, unlisted])).toEqual([
    one,
    sibling,
    other,
    unlisted,
  ]);
  expect(policy.modelOrder).toEqual([missing]);
});
