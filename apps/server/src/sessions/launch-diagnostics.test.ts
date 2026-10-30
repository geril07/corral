import { expect, test } from "vite-plus/test";
import { LaunchSpawnError } from "./errors.ts";
import { launchDiagnostic, launchFailureReason, redactLaunchError } from "./launch-diagnostics.ts";

const SECRET = "sk-diagnostic-sentinel-9c31";

test("an unexpected error is redacted against the referenced value before it can be shown or logged", () => {
  const redacted = redactLaunchError(new Error(`spawn failed while reading ${SECRET}`), [SECRET]);

  expect(redacted).toContain("spawn failed");
  expect(redacted).toContain("[redacted]");
  expect(redacted).not.toContain(SECRET);
  const error = new LaunchSpawnError("claude", redacted);
  expect(launchFailureReason(error)).not.toContain(SECRET);
  expect(launchDiagnostic(error)).not.toContain(SECRET);
});

test("short values are not redacted into noise", () => {
  expect(redactLaunchError(new Error("the value is on"), ["on"])).not.toContain("[redacted]");
});
