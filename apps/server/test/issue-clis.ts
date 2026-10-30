import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import { z } from "zod";

const IssueCliCall = z.object({
  command: z.enum(["gh", "glab"]),
  argv: z.array(z.string()),
  cwd: z.string(),
});
export type IssueCliCall = z.infer<typeof IssueCliCall>;

/**
 * Fake `gh` and `glab` executables first on `PATH`. They log every argv/cwd and answer from
 * `FAKE_ISSUE_RESPONSE`, or fail/sleep as the test asks; nothing reaches a real host or login.
 */
export function useFakeIssueClis() {
  let root: string;
  let bin: string;
  let logFile: string;
  let originalPath: string | undefined;
  let noIssueClis: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "corral-issue-clis-"));
    bin = join(root, "bin");
    noIssueClis = join(root, "no-issue-clis");
    mkdirSync(bin);
    mkdirSync(noIssueClis);
    originalPath = process.env["PATH"];
    writeFake(bin, "gh");
    writeFake(bin, "glab");
    for (const command of ["git", "sh"]) {
      const path = findOnPath(command, originalPath);
      if (path === undefined) continue;
      symlinkSync(path, join(noIssueClis, command));
    }
    logFile = join(root, "calls.jsonl");
    vi.stubEnv("PATH", `${bin}${delimiter}${originalPath ?? ""}`);
    vi.stubEnv("FAKE_ISSUE_LOG", logFile);
    vi.stubEnv("FAKE_ISSUE_MODE", "ok");
    vi.stubEnv("FAKE_ISSUE_RESPONSE", "");
    vi.stubEnv("FAKE_ISSUE_STDERR", "");
    vi.stubEnv("FAKE_ISSUE_EXIT", "1");
    vi.stubEnv("FAKE_ISSUE_PID_FILE", join(root, "cli.pid"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  return {
    /** The fake CLIs' invocations so far, oldest first. */
    calls(): IssueCliCall[] {
      if (!existsSync(logFile)) return [];
      return readFileSync(logFile, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => IssueCliCall.parse(JSON.parse(line)));
    },
    /** A successful answer, as the CLI's stdout. */
    answer(response: unknown): void {
      vi.stubEnv("FAKE_ISSUE_MODE", "ok");
      vi.stubEnv(
        "FAKE_ISSUE_RESPONSE",
        typeof response === "string" ? response : JSON.stringify(response),
      );
    },
    /** A failing CLI: its exit code and bounded stderr stand in for auth, 404 or network errors. */
    fail(exitCode: number, stderr: string): void {
      vi.stubEnv("FAKE_ISSUE_MODE", "fail");
      vi.stubEnv("FAKE_ISSUE_EXIT", String(exitCode));
      vi.stubEnv("FAKE_ISSUE_STDERR", stderr);
    },
    /** Writes its pid and never answers, so a timeout or cancellation has to kill it. */
    hang(): string {
      vi.stubEnv("FAKE_ISSUE_MODE", "slow");
      return join(root, "cli.pid");
    },
    /** More stdout than the import may buffer. */
    hugeOutput(): void {
      vi.stubEnv("FAKE_ISSUE_MODE", "huge");
    },
    /** Removes the fake CLIs from PATH while keeping `git` and `sh`, so manual task creation still works. */
    withoutIssueClis(): void {
      vi.stubEnv("PATH", noIssueClis);
    },
  };
}

function writeFake(bin: string, command: "gh" | "glab"): void {
  const file = join(bin, command);
  writeFileSync(
    file,
    `#!${process.execPath}
const fs = require("node:fs");
const log = process.env.FAKE_ISSUE_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ command: ${JSON.stringify(command)}, argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
if (process.env.GH_DEBUG || process.env.GLAB_DEBUG || process.env.GIT_TRACE || process.env.GIT_CURL_VERBOSE) {
  process.stderr.write("native CLI debug environment leaked\\n");
  process.exit(2);
}
const mode = process.env.FAKE_ISSUE_MODE || "ok";
if (mode === "slow") {
  const pidFile = process.env.FAKE_ISSUE_PID_FILE;
  if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
  setInterval(() => {}, 1000);
} else if (mode === "fail") {
  process.stderr.write(process.env.FAKE_ISSUE_STDERR || "the issue tool failed\\n");
  process.exit(Number(process.env.FAKE_ISSUE_EXIT || 1));
} else if (mode === "huge") {
  process.stdout.write("x".repeat(3 * 1024 * 1024), () => process.exit(0));
} else {
  process.stdout.write(process.env.FAKE_ISSUE_RESPONSE || "");
  process.exit(0);
}
`,
    { mode: 0o755 },
  );
}

function findOnPath(command: string, pathVariable: string | undefined): string | undefined {
  for (const directory of (pathVariable ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return undefined;
}
