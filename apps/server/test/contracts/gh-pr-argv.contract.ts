// Keeps the pull-request argv honest against the real `gh` installed on this machine. Offline: every
// call is pointed at `127.0.0.1:1`, so nothing leaves the machine and no login is involved; the
// assertions are about which argv the CLI *accepts*, not about an answer it cannot give. The suites'
// fake `gh` answers whatever it is handed, which is exactly why this class of defect — a flag that
// makes the CLI refuse the whole call — needs the real binary.
//
// Probed fact (`gh` 2.102.1): `gh pr view --json … --repo OWNER/REPO` exits 1 with "argument required
// when using the --repo flag"; the request number is positional (`gh pr view 7 --repo …`). The same
// holds for `pr checks`. Corral therefore passes the number whenever `--repo` is present; a read that
// fails that way left the badge on `unknown` forever and never offered settle after a merge.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "vite-plus/test";
import { isExecutable } from "../../src/agents/executable-lookup.ts";
import { checksCommand, viewCommand } from "../../src/changes/pull-request.ts";
import { nativeCliEnvironment } from "../../src/cli/native-cli.ts";

const run = promisify(execFile);
const TIMEOUT_MS = 20_000;
/** A loopback host with a port nothing listens on: `--repo` is accepted, the request is not tried. */
const DESTINATION = { host: "127.0.0.1:1", segments: ["acme", "app"] };
const REFUSAL = "argument required when using the --repo flag";

const available = isExecutable("gh", process.env["PATH"]);

interface Probe {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** One real `gh` call with Corral's own child environment; a non-zero exit is the answer. */
async function gh(args: string[], cwd: string): Promise<Probe> {
  try {
    const { stdout, stderr } = await run("gh", args, {
      cwd,
      timeout: TIMEOUT_MS,
      env: nativeCliEnvironment("github", { stripGitHubTokens: true }),
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error) {
    const failed: unknown = error;
    const field = (key: string): unknown =>
      typeof failed === "object" && failed !== null ? Reflect.get(failed, key) : undefined;
    const stdout = field("stdout");
    const stderr = field("stderr");
    const code = field("code");
    return {
      stdout: typeof stdout === "string" ? stdout : "",
      stderr: typeof stderr === "string" ? stderr : "",
      exitCode: typeof code === "number" ? code : 1,
    };
  }
}

test.skipIf(!available)(
  "gh refuses a read that names a repository without the request",
  async () => {
    const probe = await gh(
      ["pr", "view", "--json", "number", "--repo", "127.0.0.1:1/acme/app"],
      "/",
    );
    expect(probe.exitCode).not.toBe(0);
    expect(probe.stderr).toContain(REFUSAL);
  },
);

test.skipIf(!available)(
  "Corral's read argv is accepted: the request is positional when --repo is",
  async () => {
    // The real CLI is the judge: without the positional request it answers with the refusal above,
    // so this probe runs before the shape assertions that say what made the difference.
    const view = viewCommand("github", DESTINATION, 7);
    const viewProbe = await gh(view.args, "/");
    expect(viewProbe.stderr).not.toContain(REFUSAL);
    // It still fails — nothing is listening on the loopback host — but not because of the argv.
    expect(viewProbe.stderr).toMatch(/127\.0\.0\.1|connect|dial|refused|error/i);
    expect(view.args.slice(0, 3)).toEqual(["pr", "view", "7"]);
    expect(view.args).toContain("--repo");

    const checks = checksCommand("github", DESTINATION, 7);
    expect(checks).toBeDefined();
    const checksProbe = await gh(checks!.args, "/");
    expect(checksProbe.stderr).not.toContain(REFUSAL);
    expect(checks!.args.slice(0, 3)).toEqual(["pr", "checks", "7"]);
  },
);

test.skipIf(!available)("a read without --repo keeps gh's own branch lookup", async () => {
  const view = viewCommand("github", undefined, 7);
  // The selector is the repository flag's requirement, not a Corral rule: without `--repo` the CLI
  // resolves the current branch's request, and Corral keeps that form.
  expect(view.args).toEqual([
    "pr",
    "view",
    "--json",
    "number,url,title,state,isDraft,baseRefName,headRefName,statusCheckRollup",
  ]);
  const probe = await gh(view.args, "/");
  expect(probe.stderr).not.toContain(REFUSAL);
});
