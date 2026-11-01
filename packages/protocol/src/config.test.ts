import { defaultClientConfig, defaultWorktreeRoot, namingConfigured } from "./config.ts";
import { expect, test } from "vite-plus/test";

test("naming counts as configured only when it names a profile or an agent", () => {
  const naming = defaultClientConfig("").naming;
  expect(namingConfigured(naming)).toBe(false);
  expect(namingConfigured({ ...naming, profile: { value: "gateway", source: "global" } })).toBe(
    true,
  );
  expect(namingConfigured({ ...naming, agent: { value: "pi", source: "global" } })).toBe(true);
  expect(
    namingConfigured({
      ...naming,
      model: { value: "claude-haiku-4-5", source: "global" },
    }),
  ).toBe(false);
});

test("the built-in worktree root sits below the data directory", () => {
  expect(defaultWorktreeRoot("/data/corral")).toBe("/data/corral/worktrees");
  expect(defaultWorktreeRoot("/data/corral/")).toBe("/data/corral/worktrees");
  expect(defaultClientConfig("/data/corral").tasks.worktreeRoot).toEqual({
    value: "/data/corral/worktrees",
    source: "default",
  });
});
