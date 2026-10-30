import { expect, test } from "vite-plus/test";
import { describeLaunchError } from "./launch-error.ts";

const defined = (code: string, data: unknown) => ({ code, defined: true, data });

test("each typed launch refusal becomes a sentence with names, never values", () => {
  expect(describeLaunchError(defined("LAUNCH_PROFILE_UNKNOWN", { id: "gone" }))).toBe(
    'The profile "gone" is no longer in the config file.',
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
});

test("an unexpected spawn failure shows its redacted summary", () => {
  expect(
    describeLaunchError(
      defined("LAUNCH_FAILED", { kind: "claude", message: "spawn /usr/bin/claude EAGAIN" }),
    ),
  ).toBe("The claude session could not be launched: spawn /usr/bin/claude EAGAIN.");
});

test("errors outside the launch contract fall through to the generic describer", () => {
  expect(describeLaunchError(defined("AGENT_NOT_FOUND", { command: "claude" }))).toBeUndefined();
  expect(describeLaunchError(new Error("boom"))).toBeUndefined();
  expect(describeLaunchError({ code: "LAUNCH_FAILED", defined: false, data: {} })).toBeUndefined();
});
