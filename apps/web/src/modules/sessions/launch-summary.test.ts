import type { Session } from "@corral/protocol/rpc";
import { expect, test } from "vite-plus/test";
import { compactLaunchLabel, launchFacts, launchLine } from "./launch-summary.ts";

const session = (launch: Session["launch"]): Pick<Session, "kind" | "launch"> => ({
  kind: "claude",
  launch,
});

const profileLaunch: NonNullable<Session["launch"]> = {
  kind: "claude",
  profile: { id: "claude-gateway", name: "Claude gateway", revision: "0123456789ab" },
  model: "claude-sonnet-4-5",
  provider: null,
  env: [{ targetName: "ANTHROPIC_AUTH_TOKEN", fromEnv: "CLAUDE_TOKEN" }],
};

test("a snapshot is shown from its own choices, with reference names only", () => {
  const line = launchLine(session(profileLaunch));
  expect(line?.text).toBe("Claude gateway · claude-sonnet-4-5");
  expect(line?.details).toContain("profile claude-gateway (0123456789ab)");
  expect(line?.details).toContain("env ANTHROPIC_AUTH_TOKEN from server CLAUDE_TOKEN");
  expect(compactLaunchLabel(session(profileLaunch))).toBe("Claude gateway");
});

test("a bare model choice has no profile and shows the model", () => {
  const launch = { ...profileLaunch, profile: null, env: [] };
  expect(launchLine(session(launch))?.text).toBe("claude-sonnet-4-5");
  expect(compactLaunchLabel(session(launch))).toBe("claude-sonnet-4-5");
});

test("a provider and an env-only profile read as such", () => {
  const codex = {
    ...profileLaunch,
    kind: "codex" as const,
    provider: "openai",
    env: [],
  };
  expect(launchLine({ kind: "codex", launch: codex })?.text).toContain("provider openai");

  const opencode = {
    ...profileLaunch,
    kind: "opencode" as const,
    model: null,
    provider: null,
    env: [{ targetName: "OPENAI_API_KEY", fromEnv: "TEAM_KEY" }],
  };
  expect(launchLine({ kind: "opencode", launch: opencode })?.text).toBe(
    "Claude gateway · no model choice",
  );
});

test("a native-default launch claims no model, and an old session claims nothing", () => {
  expect(launchLine(session(null))?.text).toBe("agent default model");
  expect(compactLaunchLabel(session(null))).toBeUndefined();
  expect(launchFacts(session(null))).toEqual({
    profile: null,
    profileId: null,
    revision: null,
    model: null,
    provider: null,
    env: [],
  });

  const legacy = launchLine(session(undefined));
  expect(legacy?.text).toContain("unknown");
  expect(legacy?.text).not.toContain("model ·");
  expect(compactLaunchLabel(session(undefined))).toBeUndefined();
  expect(launchFacts(session(undefined))).toBeUndefined();
});

test("a shell never carries launch prose", () => {
  expect(launchLine({ kind: "shell", launch: null })).toBeUndefined();
});
