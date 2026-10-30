import { AGENT_LAUNCH_CAPABILITY } from "@corral/protocol/config";
import { AgentKind } from "@corral/protocol/rpc";
import { expect, test } from "vite-plus/test";
import { modelOverride, modelProblem, supportsModel } from "./launch-choice.ts";

test("the picker hides a model field exactly where the shared capability table does", () => {
  for (const kind of AgentKind.options) {
    expect(supportsModel(kind)).toBe(AGENT_LAUNCH_CAPABILITY[kind].model);
  }
  expect(supportsModel("opencode")).toBe(false);
});

test("an empty field is no override; spaces alone are not a model", () => {
  expect(modelOverride("")).toBeUndefined();
  expect(modelOverride("   ")).toBeUndefined();
  expect(modelOverride("  gpt-5-codex ")).toBe("gpt-5-codex");
});

test("the documented native model shape is accepted and a chat name is not", () => {
  for (const valid of ["claude-sonnet-4-5", "anthropic/claude-sonnet-4:high", "gpt-5-codex", "a"]) {
    expect(modelProblem("pi", valid)).toBeUndefined();
  }
  expect(modelProblem("claude", "claude sonnet")).toContain("native model id");
  expect(modelProblem("claude", "/leading")).toContain("native model id");
  expect(modelProblem("opencode", "anything")).toBeUndefined();
});
