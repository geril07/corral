import { expect, test } from "vite-plus/test";
import { namingArgs } from "./naming-command.ts";

test("claude runs print mode with no session saved and no tools, with its model flag", () => {
  expect(
    namingArgs({ kind: "claude", model: "claude-haiku-4-5", provider: null }, "Name this"),
  ).toEqual([
    "-p",
    "--tools",
    "",
    "--no-session-persistence",
    "--model",
    "claude-haiku-4-5",
    " Name this",
  ]);
});

test("pi runs print mode with no session or tools and passes its provider and model", () => {
  expect(
    namingArgs(
      { kind: "pi", model: "anthropic/claude-sonnet-4", provider: "anthropic" },
      "Name it",
    ),
  ).toEqual([
    "-p",
    "--no-session",
    "--no-tools",
    "--provider",
    "anthropic",
    "--model",
    "anthropic/claude-sonnet-4",
    "Name it",
  ]);
});

test("codex runs an ephemeral exec outside a git repository, with the prompt after --", () => {
  expect(namingArgs({ kind: "codex", model: "gpt-5-codex", provider: "work" }, "Name it")).toEqual([
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "-m",
    "gpt-5-codex",
    "-c",
    "model_provider=work",
    "--",
    "Name it",
  ]);
});

test("a prompt that looks like a flag stays an operand for pi and codex", () => {
  expect(namingArgs({ kind: "pi", model: null, provider: null }, "-x")).toEqual([
    "-p",
    "--no-session",
    "--no-tools",
    "--",
    "-x",
  ]);
  expect(namingArgs({ kind: "codex", model: null, provider: null }, "-x")).toContain("--");
});

test("opencode cannot name: it has no non-interactive mode that saves no session", () => {
  expect(
    namingArgs({ kind: "opencode", model: null, provider: null }, "Name this"),
  ).toBeUndefined();
});
