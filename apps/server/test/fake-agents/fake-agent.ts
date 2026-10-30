// A stand-in for the claude, codex, pi and opencode CLIs: `bin/<name>` runs this with the name.
//
// - appends one JSON line per launch (arguments, working directory, CORRAL_* environment) to
//   the file named by $FAKE_AGENT_LOG;
// - prints `fake <name> ready`, then reads lines from stdin: `exit [code]` exits, anything
//   else is answered with `fake <name> got: <line>`;
// - the fake claude models "no conversation yet" as the real one does: `--resume <id>` of an id
//   without a transcript prints the real message and exits 1. A `--session-id <id>` conversation
//   gets its transcript in $CLAUDE_CONFIG_DIR/projects at the first line that is not a command
//   (`lazy`, the default) or at start (`eager`), per $FAKE_CLAUDE_TRANSCRIPT;
// - the fake codex, when it starts a new conversation, writes a rollout file into
//   $CODEX_HOME/sessions as the real one does, per $FAKE_CODEX_ROLLOUT: `eager` (the default)
//   at start, `lazy` on the first line that is not a command, `never` not at all.
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { claudeTranscriptExists, writeClaudeTranscript } from "../claude-transcripts.ts";
import { writeRollout } from "../rollouts.ts";

const [name, ...argv] = process.argv.slice(2);
const codexHome = process.env["CODEX_HOME"];
if (name === "codex" && !codexHome) {
  console.error("fake codex: refusing to run without CODEX_HOME, it would use the real ~/.codex");
  process.exit(99);
}

const claudeConfigDir = process.env["CLAUDE_CONFIG_DIR"];
if (name === "claude" && !claudeConfigDir) {
  console.error(
    "fake claude: refusing to run without CLAUDE_CONFIG_DIR, it would use the real ~/.claude",
  );
  process.exit(99);
}
const claudeFlag = name === "claude" ? argv[0] : undefined;
const claudeId = name === "claude" ? argv[1] : undefined;
if (claudeFlag === "--resume" && claudeId && !claudeTranscriptExists(claudeConfigDir!, claudeId)) {
  console.error(`No conversation found with session ID: ${claudeId}`);
  process.exit(1);
}

const startsConversation = name === "codex" && argv[0] !== "resume";
const rolloutMode = process.env["FAKE_CODEX_ROLLOUT"] ?? "eager";
const rolloutId = startsConversation ? randomUUID() : undefined;

const logFile = process.env["FAKE_AGENT_LOG"];
if (logFile) {
  const launch = {
    agent: name,
    argv,
    cwd: process.cwd(),
    pid: process.pid,
    rolloutId,
    env: {
      CORRAL_SESSION_ID: process.env["CORRAL_SESSION_ID"],
      CORRAL_TASK_ID: process.env["CORRAL_TASK_ID"],
    },
  };
  appendFileSync(logFile, `${JSON.stringify(launch)}\n`);
}

let rolloutWritten = false;
function writeRolloutOnce(): void {
  if (rolloutWritten || rolloutId === undefined || codexHome === undefined) return;
  rolloutWritten = true;
  writeRollout(codexHome, { id: rolloutId, cwd: process.cwd() });
}
if (rolloutMode === "eager") writeRolloutOnce();

const transcriptMode = process.env["FAKE_CLAUDE_TRANSCRIPT"] ?? "lazy";
function writeTranscriptOnce(): void {
  if (claudeId && claudeConfigDir) writeClaudeTranscript(claudeConfigDir, process.cwd(), claudeId);
}
if (transcriptMode === "eager") writeTranscriptOnce();

console.log(`fake ${name} ready`);

let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  pending += chunk;
  for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
    const line = pending.slice(0, newline).replace(/\r$/, "");
    pending = pending.slice(newline + 1);
    const exit = /^exit(?: (\d+))?$/.exec(line);
    if (exit) process.exit(Number(exit[1] ?? 0));
    if (rolloutMode === "lazy") writeRolloutOnce();
    if (transcriptMode === "lazy") writeTranscriptOnce();
    console.log(`fake ${name} got: ${line}`);
  }
});
