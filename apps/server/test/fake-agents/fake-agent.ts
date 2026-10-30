// A stand-in for the claude, codex, pi and opencode CLIs: `bin/<name>` runs this with the name.
//
// - appends one JSON line per launch (arguments, working directory, CORRAL_* environment) to
//   the file named by $FAKE_AGENT_LOG;
// - prints `fake <name> ready`, then reads lines from stdin: `exit [code]` exits, anything
//   else is answered with `fake <name> got: <line>`;
// - the fake codex, when it starts a new conversation, writes a rollout file into
//   $CODEX_HOME/sessions as the real one does, per $FAKE_CODEX_ROLLOUT: `eager` (the default)
//   at start, `lazy` on the first line that is not a command, `never` not at all.
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { writeRollout } from "../rollouts.ts";

const [name, ...argv] = process.argv.slice(2);
const codexHome = process.env["CODEX_HOME"];
if (name === "codex" && !codexHome) {
  console.error("fake codex: refusing to run without CODEX_HOME, it would use the real ~/.codex");
  process.exit(99);
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
    console.log(`fake ${name} got: ${line}`);
  }
});
