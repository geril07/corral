import { ORPCError } from "@orpc/client";
import { expect, test } from "vite-plus/test";
import {
  chatUnavailableReason,
  describeError,
  dirtyWorktreeFiles,
  procedureMissing,
} from "./rpc-errors.ts";

// The server sends these over the wire as defined errors, which the client rebuilds as ORPCError.
function defined(code: string, data: unknown) {
  return new ORPCError(code, { defined: true, data });
}

test("typed errors become sentences, git's own message stays as it is", () => {
  expect(describeError(defined("NOT_A_GIT_REPOSITORY", { path: "/tmp/x" }))).toBe(
    "/tmp/x is not inside a git repository.",
  );
  expect(describeError(defined("PROJECT_EXISTS", { id: "p1" }))).toBe(
    "This repository is already added.",
  );
  expect(
    describeError(defined("GIT_FAILED", { message: "fatal: 'x' is already checked out" })),
  ).toBe("fatal: 'x' is already checked out");
});

test("a missing agent names the command, and session errors are explained", () => {
  expect(describeError(defined("AGENT_NOT_FOUND", { command: "claude" }))).toBe(
    "claude was not found on the server's PATH.",
  );
  expect(describeError(defined("SESSION_NOT_FOUND", { id: "s1" }))).toBe(
    "This session no longer exists.",
  );
  expect(describeError(defined("ALREADY_RUNNING", undefined))).toBe(
    "This session is already running.",
  );
});

test("a typed error is recognized by shape, not only as an ORPCError instance", () => {
  // A browser can hold a second copy of the client package; the wire error is still this shape.
  const wire = {
    defined: true,
    code: "CHAT_MODEL_UNSUPPORTED",
    data: { model: { provider: "stub", id: "stub-9" } },
  };
  expect(describeError(wire)).toBe("The agent does not offer the model stub-9.");
});

test("a refused model, level or disabled agent names what the server refused", () => {
  expect(
    describeError(defined("CHAT_MODEL_UNSUPPORTED", { model: { provider: "stub", id: "stub-9" } })),
  ).toBe("The agent does not offer the model stub-9.");
  expect(describeError(defined("CHAT_REASONING_UNSUPPORTED", { level: "low" }))).toBe(
    'The agent has no reasoning level "low".',
  );
  expect(describeError(defined("AGENT_DISABLED", { kind: "claude" }))).toBe(
    "The claude agent is disabled in the config file.",
  );
  // A custom `[agents.<kind>].command` is a path, so PATH is not where it was looked for.
  expect(describeError(defined("AGENT_NOT_FOUND", { command: "/opt/pi/bin/pi" }))).toBe(
    "/opt/pi/bin/pi is not an executable the server can run.",
  );
  expect(describeError(defined("AGENT_NOT_FOUND", { command: "C:\\tools\\pi.exe" }))).toBe(
    "C:\\tools\\pi.exe is not an executable the server can run.",
  );
});

test("a launch profile pinned to a changed revision is explained", () => {
  expect(describeError(defined("LAUNCH_PROFILE_CHANGED", { id: "p1" }))).toBe(
    "The launch profile changed since you chose it. Reload and choose it again.",
  );
  expect(describeError(defined("LAUNCH_PROFILE_REVISION_UNSUPPORTED", undefined))).toBe(
    "A pinned profile revision requires a selected profile.",
  );
});

test("issue import failures name the missing tool, host or provider", () => {
  expect(
    describeError(defined("ISSUE_URL_INVALID", { message: "This is not an issue URL." })),
  ).toBe("This is not an issue URL.");
  expect(describeError(defined("ISSUE_PROVIDER_REQUIRED", { host: "gitlab.example.com" }))).toBe(
    "Choose whether gitlab.example.com runs GitHub or GitLab.",
  );
  expect(describeError(defined("ISSUE_CLI_MISSING", { command: "glab" }))).toBe(
    "glab was not found on the server's PATH.",
  );
  expect(
    describeError(
      defined("ISSUE_HOST_UNTRUSTED", { provider: "github", host: "attacker.example" }),
    ),
  ).toBe(
    "attacker.example is not a configured GitHub host for this project. Add it as a git remote or set GH_HOST on the server, or create the task manually.",
  );
  expect(
    describeError(
      defined("ISSUE_UNSUPPORTED_PORT", { provider: "github", host: "ghe.example.com:8443" }),
    ),
  ).toBe(
    "GitHub issues on a nonstandard port are not supported. Use a standard host or create the task manually.",
  );
  expect(describeError(defined("ISSUE_AUTH_REQUIRED", { provider: "gitlab" }))).toBe(
    "The server's GitLab CLI is not logged in for this host.",
  );
  expect(describeError(defined("ISSUE_FETCH_TIMEOUT", { provider: "github" }))).toBe(
    "Reading the issue timed out. You can create the task without its metadata.",
  );
  expect(describeError(defined("ISSUE_RESPONSE_INVALID", { provider: "github" }))).toBe(
    "The issue tool returned something Corral could not read.",
  );
  expect(describeError(defined("ISSUE_FETCH_FAILED", { message: "HTTP 404: Not Found" }))).toBe(
    "HTTP 404: Not Found",
  );
});

test("an error outside the contract falls back to its message", () => {
  expect(describeError(new Error("not connected to the server"))).toBe(
    "not connected to the server",
  );
  expect(describeError(new ORPCError("INTERNAL_SERVER_ERROR", { message: "boom" }))).toBe("boom");
  expect(describeError("plain")).toBe("plain");
});

test("a chat refusal keeps the server's sentence and reason, not the error code", () => {
  const refusal = defined("CHAT_UNAVAILABLE", {
    message: "This server has no chat driver for any session yet.",
    reason: "not-started",
  });
  expect(describeError(refusal)).toBe("This server has no chat driver for any session yet.");
  expect(chatUnavailableReason(refusal)).toBe("not-started");
  expect(chatUnavailableReason(defined("GIT_FAILED", { message: "x" }))).toBeUndefined();
  expect(chatUnavailableReason(new Error("CHAT_UNAVAILABLE"))).toBeUndefined();
});

test("only WORKTREE_DIRTY yields the list of blocking files", () => {
  expect(dirtyWorktreeFiles(defined("WORKTREE_DIRTY", { files: ["a.txt", "b/c.ts"] }))).toEqual([
    "a.txt",
    "b/c.ts",
  ]);
  expect(dirtyWorktreeFiles(defined("GIT_FAILED", { message: "x" }))).toBeUndefined();
  expect(dirtyWorktreeFiles(new Error("WORKTREE_DIRTY"))).toBeUndefined();
});

test("the Changes tab's write refusals say what was confirmed and what the server found", () => {
  expect(
    describeError(
      defined("CHANGES_REMOTE_MISMATCH", {
        remote: "origin",
        confirmed: "https://forge.example/acme/app.git",
        actual: "https://forge.example/acme/mirror.git",
      }),
    ),
  ).toBe(
    "The remote origin is no longer https://forge.example/acme/app.git; it is https://forge.example/acme/mirror.git. Reload the tab and confirm the new one.",
  );
  expect(describeError(defined("CHANGES_NO_REMOTE", { branch: "feat-x" }))).toBe(
    "No remote would take the branch feat-x. Add a remote, or set branch.<name>.remote.",
  );
  expect(
    describeError(defined("CHANGES_BRANCH_MISMATCH", { confirmed: "feat-x", actual: null })),
  ).toBe("The workspace is on a detached HEAD, not the confirmed feat-x.");
  expect(describeError(defined("CHANGES_NOTHING_STAGED", {}))).toBe(
    "Nothing is staged: select files to commit first.",
  );
  expect(describeError(defined("CHANGES_EMPTY_MESSAGE", {}))).toBe("A commit needs a message.");
  expect(
    describeError(defined("CHANGES_PUSH_REQUIRED", { remote: "origin", branch: "feat-x" })),
  ).toBe("origin has no branch feat-x yet. Push it first.");
  expect(describeError(defined("CHANGES_CLI_MISSING", { command: "glab" }))).toBe(
    "glab was not found on the server's PATH.",
  );
  expect(describeError(defined("CHANGES_AUTH_REQUIRED", { provider: "gitlab" }))).toBe(
    "The server's GitLab CLI is not logged in for this host.",
  );
  expect(
    describeError(
      defined("CHANGES_CLI_FAILED", { provider: "github", message: "Could not reach GitHub." }),
    ),
  ).toBe("Could not reach GitHub.");
  expect(describeError(defined("CHANGES_RESPONSE_INVALID", { provider: "gitlab" }))).toBe(
    "The GitLab CLI returned something Corral could not read.",
  );
});

test("an unknown procedure is the daemon's age, not a failed write", () => {
  // oRPC's own answer for a path the server has no handler for: not a contract error.
  expect(procedureMissing({ code: "NOT_FOUND", defined: false, message: "Not Found" })).toBe(true);
  expect(procedureMissing(new Error("Not Found"))).toBe(false);
  // A typed NOT_FOUND (a terminal that is gone) is not an old daemon.
  expect(procedureMissing(defined("NOT_FOUND", { id: "t1" }))).toBe(false);
  expect(procedureMissing(undefined)).toBe(false);
});
