import type { Session } from "@corral/protocol/rpc";
import { expect, test } from "vite-plus/test";
import { compactLaunchLabel, launchFacts } from "./launch-summary.ts";

const profileLaunch: NonNullable<Session["launch"]> = {
  kind: "claude",
  profile: { id: "claude-gateway", name: "Claude gateway", revision: "0123456789ab" },
  model: "claude-sonnet-4-5",
  provider: null,
  env: [{ targetName: "ANTHROPIC_AUTH_TOKEN", fromEnv: "CLAUDE_TOKEN" }],
};

test("the sidebar reads immutable launch facts and prefers the profile name", () => {
  expect(launchFacts({ launch: profileLaunch })).toEqual({
    profile: "Claude gateway",
    profileId: "claude-gateway",
    revision: "0123456789ab",
    model: "claude-sonnet-4-5",
    provider: null,
    env: profileLaunch.env,
  });
  expect(compactLaunchLabel({ launch: profileLaunch })).toBe("Claude gateway");
});

test("a bare model choice has no profile and shows the model", () => {
  const launch = { ...profileLaunch, profile: null, env: [], provider: "openai" };
  expect(compactLaunchLabel({ launch })).toBe("claude-sonnet-4-5");
  expect(launchFacts({ launch })).toEqual({
    profile: null,
    profileId: null,
    revision: null,
    model: "claude-sonnet-4-5",
    provider: "openai",
    env: [],
  });
});

test("a native default claims no model, and an old session claims nothing", () => {
  expect(compactLaunchLabel({ launch: null })).toBeUndefined();
  expect(launchFacts({ launch: null })).toEqual({
    profile: null,
    profileId: null,
    revision: null,
    model: null,
    provider: null,
    env: [],
  });
  expect(compactLaunchLabel({ launch: undefined })).toBeUndefined();
  expect(launchFacts({ launch: undefined })).toBeUndefined();
});
