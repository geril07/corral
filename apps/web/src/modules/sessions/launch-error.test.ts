import { expect, test } from "vite-plus/test";
import { workspaceMissingMessage } from "@corral/protocol/workspace";
import { describeLaunchError, launchErrorCode } from "./launch-error.ts";

const defined = (code: string, data: unknown) => ({ code, defined: true, data });

test("each typed launch refusal becomes a sentence with names, never values", () => {
  expect(describeLaunchError(defined("LAUNCH_PROFILE_UNKNOWN", { id: "gone" }))).toBe(
    'The profile "gone" is no longer in the config file. Choose an agent or another profile.',
  );
  expect(
    describeLaunchError(defined("LAUNCH_PROFILE_KIND_MISMATCH", { id: "p", kind: "codex" })),
  ).toContain("does not start a codex session");
  expect(describeLaunchError(defined("LAUNCH_MODEL_UNSUPPORTED", { kind: "opencode" }))).toBe(
    "opencode has no model choice at launch.",
  );
  expect(describeLaunchError(defined("LAUNCH_MODEL_INVALID", { kind: "claude" }))).toContain(
    "not a valid model id for claude",
  );
  expect(
    describeLaunchError(defined("LAUNCH_ENV_MISSING", { profileId: "p", name: "SERVER_TOKEN" })),
  ).toBe('The server has no environment variable SERVER_TOKEN for profile "p".');
  expect(
    describeLaunchError(defined("LAUNCH_ENV_MISSING", { profileId: null, name: "SERVER_TOKEN" })),
  ).toBe("The server has no environment variable SERVER_TOKEN.");
  expect(describeLaunchError(defined("LAUNCH_ENV_RESERVED", { name: "HOME" }))).toBe(
    "A profile may not set HOME.",
  );
  // The composer and the agent picker call this first, so this copy is the sentence users see.
  expect(describeLaunchError(defined("AGENT_DISABLED", { kind: "claude" }))).toBe(
    "The claude agent is disabled in the config file. Choose another agent.",
  );
});

test("unsupported chat launches name the shell constraint or missing agent driver", () => {
  expect(
    describeLaunchError(defined("LAUNCH_VIEW_UNSUPPORTED", { kind: "shell", view: "chat" })),
  ).toBe("A shell runs in a terminal only.");
  expect(
    describeLaunchError(defined("LAUNCH_VIEW_UNSUPPORTED", { kind: "claude", view: "chat" })),
  ).toBe("The claude agent has no chat driver in this build.");
});

test("a pinned revision conflict and an invalid revision-only launch are explained", () => {
  const changed = defined("LAUNCH_PROFILE_CHANGED", { id: "claude-gateway" });
  expect(launchErrorCode(changed)).toBe("LAUNCH_PROFILE_CHANGED");
  expect(describeLaunchError(changed)).toBe(
    'The profile "claude-gateway" changed on the server. Review it and choose it again.',
  );
  expect(describeLaunchError(defined("LAUNCH_PROFILE_REVISION_UNSUPPORTED", undefined))).toBe(
    "A pinned profile revision needs a selected profile.",
  );
});

test("an unexpected spawn failure shows its redacted summary", () => {
  expect(
    describeLaunchError(
      defined("LAUNCH_FAILED", { kind: "claude", message: "spawn /usr/bin/claude EAGAIN" }),
    ),
  ).toBe("The claude session could not be launched: spawn /usr/bin/claude EAGAIN.");
});

test("a missing workspace sentence is not wrapped in the generic launch failure", () => {
  const path = "/data/worktrees/app/fix-login";
  expect(
    describeLaunchError(
      defined("LAUNCH_FAILED", { kind: "shell", message: workspaceMissingMessage(path) }),
    ),
  ).toBe(workspaceMissingMessage(path));
});

test("errors outside the launch contract fall through to the generic describer", () => {
  expect(describeLaunchError(defined("AGENT_NOT_FOUND", { command: "claude" }))).toBeUndefined();
  expect(describeLaunchError(new Error("boom"))).toBeUndefined();
  expect(launchErrorCode(new Error("boom"))).toBeUndefined();
  expect(describeLaunchError({ code: "LAUNCH_FAILED", defined: false, data: {} })).toBeUndefined();
});
