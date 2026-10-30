import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

// Named by process, like the repositories and fake agents: the Vite config and the global setup
// load this module in one process, while browser tests reach it through custom commands.
const root = join(tmpdir(), `corral-web-issue-clis-${process.pid}`);
const bin = join(root, "bin");
const noIssueClis = join(root, "no-issue-clis");
const logFile = join(root, "calls.jsonl");

/**
 * Writes fake `gh` and `glab` executables and puts them first on the server's PATH, so no browser
 * test can reach a real host or login. The scripts log argv/cwd and answer from
 * `FAKE_ISSUE_RESPONSE` (or `FAKE_ISSUE_RESPONSE_FILE`).
 */
export function createFakeIssueCliBin(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  writeFake(binDir, "gh");
  writeFake(binDir, "glab");
}

export function useFakeIssueClis() {
  createFakeIssueCliBin(bin);
  mkdirSync(noIssueClis, { recursive: true });
  // A PATH for "the CLI is missing" that still lets git create a plain task.
  for (const command of ["git", "sh", "node"]) {
    const found = findOnPath(command, process.env["PATH"]);
    if (found !== undefined) symlinkSync(found, join(noIssueClis, command));
  }
  const originalPath = process.env["PATH"] ?? "";
  process.env["PATH"] = `${bin}${delimiter}${originalPath}`;
  process.env["FAKE_ISSUE_PATH"] = process.env["PATH"];
  process.env["FAKE_ISSUE_NO_CLI_PATH"] = noIssueClis;
  process.env["FAKE_ISSUE_LOG"] = logFile;
  process.env["FAKE_ISSUE_MODE"] = "ok";
  process.env["FAKE_ISSUE_RESPONSE"] = "";
  process.env["FAKE_ISSUE_STDERR"] = "";
  process.env["FAKE_ISSUE_EXIT"] = "1";
  return () => rmSync(root, { recursive: true, force: true });
}

export function issueCliCalls(): unknown[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line): unknown => JSON.parse(line));
}

export function clearIssueCliCalls(): void {
  rmSync(logFile, { force: true });
}

/** `missing`: git, sh and node only; `with`: the fake gh/glab are first. */
export function issueCliPath(_context: unknown, kind: "missing" | "with"): string {
  const value = process.env[kind === "missing" ? "FAKE_ISSUE_NO_CLI_PATH" : "FAKE_ISSUE_PATH"];
  if (value === undefined) throw new Error("the browser test global setup did not run");
  return value;
}

function writeFake(binDir: string, command: "gh" | "glab"): void {
  writeFileSync(
    join(binDir, command),
    `#!${process.execPath}
const fs = require("node:fs");
const log = process.env.FAKE_ISSUE_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ command: ${JSON.stringify(command)}, argv: process.argv.slice(2), cwd: process.cwd() }) + "\\n");
if (process.env.GH_DEBUG || process.env.GLAB_DEBUG || process.env.GIT_TRACE || process.env.GIT_CURL_VERBOSE) {
  process.stderr.write("native CLI debug environment leaked\\n");
  process.exit(2);
}
const mode = process.env.FAKE_ISSUE_MODE || "ok";
if (mode === "fail") {
  process.stderr.write(process.env.FAKE_ISSUE_STDERR || "the issue tool failed\\n");
  process.exit(Number(process.env.FAKE_ISSUE_EXIT || 1));
}
const responseFile = process.env.FAKE_ISSUE_RESPONSE_FILE;
const response = responseFile && fs.existsSync(responseFile) ? fs.readFileSync(responseFile, "utf8") : (process.env.FAKE_ISSUE_RESPONSE || "");
process.stdout.write(response);
process.exit(0);
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
