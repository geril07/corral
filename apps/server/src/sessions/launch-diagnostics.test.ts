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

test("every non-empty referenced value is redacted, including short, multiline and overlapping ones", () => {
  const multiline = "abc\ndef";
  const redacted = redactLaunchError(new Error(`value ${multiline} then abc and x`), [
    multiline,
    "abc",
    "x",
    "",
  ]);

  expect(redacted).not.toContain(multiline);
  expect(redacted).not.toContain("abc");
  expect(redacted).not.toContain("x");
  expect(redacted).toContain("[redacted]");
});

test("an unknown error keeps a safe name and OS code without quoting its message", () => {
  const error = Object.assign(new Error(`boom ${SECRET}`), { name: "SpawnError", code: "EMFILE" });
  const reason = launchFailureReason(error);

  expect(reason).toContain("SpawnError");
  expect(reason).toContain("EMFILE");
  expect(reason).not.toContain(SECRET);
  expect(reason).not.toContain("see the server log");
  expect(launchDiagnostic(error)).not.toContain(SECRET);
});
