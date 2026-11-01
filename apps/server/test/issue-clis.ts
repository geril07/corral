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
import { fakeCliScript } from "./fake-cli-script.ts";

const IssueCliCall = z.object({
  command: z.enum(["gh", "glab"]),
  argv: z.array(z.string()),
  cwd: z.string(),
  /** What a `--body-file -`/`--description-file -` call sent on stdin; absent when it sent nothing. */
  stdin: z.string().optional(),
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
    vi.stubEnv("FAKE_PR_URL", DEFAULT_PR_URL);
    vi.stubEnv("FAKE_PR_VIEW", "");
    vi.stubEnv("FAKE_PR_CHECKS", "[]");
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
    /** The URL `pr create`/`mr create` prints; a `.invalid` host, so no real forge name is in play. */
    createdUrl(url: string): void {
      vi.stubEnv("FAKE_PR_URL", url);
    },
    /** What `gh pr view`/`glab mr view` prints. */
    view(json: unknown): void {
      vi.stubEnv("FAKE_PR_VIEW", JSON.stringify(json));
    },
    /** What `gh pr checks --json …` prints. */
    checks(checks: unknown): void {
      vi.stubEnv("FAKE_PR_CHECKS", JSON.stringify(checks));
    },
  };
}

const DEFAULT_PR_URL = "https://forge.invalid/acme/app/pull/7";

function writeFake(bin: string, command: "gh" | "glab"): void {
  writeFileSync(join(bin, command), fakeCliScript(command), { mode: 0o755 });
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
