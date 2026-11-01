import { defaultClientConfig, type LaunchProfile } from "@corral/protocol/config";
import { expect, test } from "vite-plus/test";
import {
  agentChoices,
  defaultAgent,
  defaultWorkspace,
  isBranchKey,
  workspaceChoices,
} from "./new-task-defaults.ts";

const gateway: LaunchProfile = {
  id: "gateway",
  revision: "3",
  name: "Gateway",
  agent: "claude",
  model: "claude-sonnet-4-5",
  provider: null,
  env: [],
};

function settings(overrides: {
  agent?: "claude" | "codex" | "pi" | "opencode" | null;
  profile?: string | null;
  model?: string | null;
  workspace?: "main-worktree" | "new-worktree";
}) {
  const base = defaultClientConfig("/data").tasks;
  return {
    ...base,
    agent: { value: overrides.agent ?? null, source: "global" as const },
    profile: { value: overrides.profile ?? null, source: "global" as const },
    model: { value: overrides.model ?? null, source: "global" as const },
    workspace: {
      value: overrides.workspace ?? "main-worktree",
      source: "global" as const,
    },
  };
}

test("a configured profile wins over the agent and the model setting overrides its model", () => {
  expect(defaultAgent(settings({ agent: "codex", profile: "gateway" }), [gateway])).toEqual({
    key: "profile:gateway:3",
    label: "Gateway · claude-sonnet-4-5",
    choice: { kind: "claude", profileId: "gateway", expectedProfileRevision: "3" },
  });
  expect(
    defaultAgent(settings({ agent: "codex", profile: "gateway", model: "gpt-5-codex" }), [gateway]),
  ).toEqual({
    key: "profile:gateway:3",
    label: "Gateway · gpt-5-codex",
    choice: {
      kind: "claude",
      profileId: "gateway",
      expectedProfileRevision: "3",
      model: "gpt-5-codex",
    },
  });
});

test("without a profile the configured agent wins, and a missing profile falls back to it", () => {
  expect(defaultAgent(settings({ agent: "pi", model: "pi-large" }), [])).toMatchObject({
    key: "native:pi",
    label: "pi · pi-large",
    choice: { kind: "pi", model: "pi-large" },
  });
  expect(defaultAgent(settings({ agent: "codex", profile: "gone" }), [gateway])).toMatchObject({
    key: "native:codex",
    choice: { kind: "codex" },
  });
  // Nothing configured: the first native agent, so a prompt always has an agent to start.
  expect(defaultAgent(settings({}), []).choice.kind).toBe("claude");
});

test("the picker lists native agents first, then the config's profiles", () => {
  expect(agentChoices([gateway]).map((choice) => choice.key)).toEqual([
    "native:claude",
    "native:codex",
    "native:pi",
    "native:opencode",
    "profile:gateway:3",
  ]);
});

test("the workspace picker offers the main tree, a new worktree and every existing branch", () => {
  expect(workspaceChoices(["main", "feature/x"]).map((choice) => choice.label)).toEqual([
    "main tree",
    "new worktree",
    "main",
    "feature/x",
  ]);
  expect(workspaceChoices(["main"]).at(-1)?.input).toEqual({
    type: "existing-branch",
    branch: "main",
  });
  expect(isBranchKey(workspaceChoices(["main"]).at(-1)!.key)).toBe(true);
  expect(isBranchKey("new-worktree")).toBe(false);
});

test("the workspace default is the project's configured mode", () => {
  expect(defaultWorkspace(settings({ workspace: "new-worktree" })).input).toEqual({
    type: "new-branch",
  });
  expect(defaultWorkspace(settings({})).input).toEqual({ type: "main-worktree" });
});
