/**
 * The body of the fake `gh`/`glab` executable, shared by the server and web test fixtures so the
 * two copies cannot drift. It logs every call (argv, cwd and the stdin body a `--body-file -`
 * call sends), refuses to run with a native CLI's debug output enabled, and answers:
 *
 * - `issue view …` from `FAKE_ISSUE_RESPONSE_FILE` / `FAKE_ISSUE_RESPONSE`;
 * - `pr|mr create` from `FAKE_PR_URL`;
 * - `pr checks --json …` from `FAKE_PR_CHECKS`;
 * - `pr|mr view …` from `FAKE_PR_VIEW`.
 *
 * `FAKE_ISSUE_MODE` makes every call fail, hang or flood instead (`fail`, `slow`, `huge`). Nothing
 * leaves the machine: the executable is Node, writes only its journal and touches no network.
 */
export function fakeCliScript(command: "gh" | "glab"): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const argv = process.argv.slice(2);
// Only a call that reads the body from stdin is waited on: a caller that leaves stdin open (the
// issue import does not write to it) would otherwise block the fake forever.
const readsStdin = argv.some((arg, index) => (arg === "--body-file" || arg === "--description-file") && argv[index + 1] === "-");
let stdin = "";
if (readsStdin) { try { stdin = fs.readFileSync(0, "utf8"); } catch { stdin = ""; } }
const log = process.env.FAKE_ISSUE_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ command: ${JSON.stringify(command)}, argv, cwd: process.cwd(), ...(stdin === "" ? {} : { stdin }) }) + "\\n");
if (process.env.GH_DEBUG || process.env.GLAB_DEBUG || process.env.GIT_TRACE || process.env.GIT_CURL_VERBOSE) {
  process.stderr.write("native CLI debug environment leaked\\n");
  process.exit(2);
}
const envNames = (value) => (value || "").split(",").filter(Boolean);
if (envNames(process.env.FAKE_ISSUE_FORBID_ENV).some((name) => process.env[name])) {
  process.stderr.write("forbidden environment was forwarded\\n");
  process.exit(3);
}
if (envNames(process.env.FAKE_ISSUE_REQUIRE_ENV).some((name) => !process.env[name])) {
  process.stderr.write("required environment was stripped\\n");
  process.exit(3);
}
const mode = process.env.FAKE_ISSUE_MODE || "ok";
if (mode === "slow") {
  const pidFile = process.env.FAKE_ISSUE_PID_FILE;
  if (pidFile) fs.writeFileSync(pidFile, String(process.pid));
  setInterval(() => {}, 1000);
} else if (mode === "fail") {
  process.stderr.write(process.env.FAKE_ISSUE_STDERR || "the tool failed\\n");
  process.exit(Number(process.env.FAKE_ISSUE_EXIT || 1));
} else if (mode === "huge") {
  process.stdout.write("x".repeat(3 * 1024 * 1024), () => process.exit(0));
} else {
  const group = argv[0];
  const verb = argv[1];
  let response = "";
  if (group === "pr" || group === "mr") {
    if (verb === "create") response = process.env.FAKE_PR_URL || "https://forge.invalid/acme/app/pull/7";
    else if (verb === "checks") response = process.env.FAKE_PR_CHECKS || "[]";
    else if (verb === "view") response = process.env.FAKE_PR_VIEW || "";
  } else {
    const responseFile = process.env.FAKE_ISSUE_RESPONSE_FILE;
    response = responseFile && fs.existsSync(responseFile) ? fs.readFileSync(responseFile, "utf8") : (process.env.FAKE_ISSUE_RESPONSE || "");
  }
  process.stdout.write(response);
  process.exit(0);
}
`;
}
