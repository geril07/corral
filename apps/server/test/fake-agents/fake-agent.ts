// A stand-in for the claude, codex, pi and opencode CLIs: `bin/<name>` runs this with the name.
//
// - appends one JSON line per launch (arguments, working directory, CORRAL_* environment) to
//   the file named by $FAKE_AGENT_LOG;
// - prints `fake <name> ready`, then reads lines from stdin: `exit [code]` exits, anything
//   else is answered with `fake <name> got: <line>`;
// - `osc <body>` prints the OSC 7501 report `body` at once, as Codex does; `probe <body>` prints the
//   `?` probe, waits for the terminal's reply, prints `fake <name> probe answered` and then the
//   report `body`, as Claude Code and pi do; `post <json>` POSTs `json` to $CORRAL_STATUS_URL with
//   $CORRAL_STATUS_TOKEN and prints `fake <name> posted <status>`, as the OpenCode plugin does;
// - the fake opencode also records what it was launched with: whether it runs `--standalone` and
//   which plugin directory $OPENCODE_CONFIG_CONTENT names, with whether the plugin file is there;
// - the fake claude models "no conversation yet" as the real one does: `--resume <id>` of an id
//   without a transcript prints the real message and exits 1. A `--session-id <id>` conversation
//   gets its transcript in $CLAUDE_CONFIG_DIR/projects at the first line that is not a command
//   (`lazy`, the default) or at start (`eager`), per $FAKE_CLAUDE_TRANSCRIPT;
// - the fake codex, when it starts a new conversation, writes a rollout file into
//   $CODEX_HOME/sessions as the real one does, per $FAKE_CODEX_ROLLOUT: `eager` (the default)
//   at start, `lazy` on the first line that is not a command, `never` not at all.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { claudeTranscriptExists, writeClaudeTranscript } from "../claude-transcripts.ts";
import { writeRollout } from "../rollouts.ts";
import { startFakePiRpc } from "./fake-pi-rpc.ts";

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
// Launch flags (--model, -c …) may precede the conversation flag.
const claudeFlagIndex =
  name === "claude" ? argv.findIndex((arg) => arg === "--session-id" || arg === "--resume") : -1;
const claudeFlag = claudeFlagIndex >= 0 ? argv[claudeFlagIndex] : undefined;
const claudeId = claudeFlagIndex >= 0 ? argv[claudeFlagIndex + 1] : undefined;
if (claudeFlag === "--resume" && claudeId && !claudeTranscriptExists(claudeConfigDir!, claudeId)) {
  console.error(`No conversation found with session ID: ${claudeId}`);
  process.exit(1);
}

const startsConversation = name === "codex" && !argv.includes("resume");
const rolloutMode = process.env["FAKE_CODEX_ROLLOUT"] ?? "eager";
const rolloutId = startsConversation ? randomUUID() : undefined;

// What the real OpenCode would load from the inline config the server hands it.
function openCodePlugin(): { configContent: string; pluginDir?: string; pluginPresent: boolean } {
  const configContent = process.env["OPENCODE_CONFIG_CONTENT"] ?? "";
  try {
    const pluginDir: unknown = JSON.parse(configContent).plugins?.[0]?.package;
    if (typeof pluginDir === "string")
      return { configContent, pluginDir, pluginPresent: existsSync(join(pluginDir, "index.js")) };
  } catch {
    // Not JSON: nothing is loaded.
  }
  return { configContent, pluginPresent: false };
}

const logFile = process.env["FAKE_AGENT_LOG"];
const loggedEnvNames = (process.env["FAKE_AGENT_LOG_ENV"] ?? "")
  .split(",")
  .map((variable) => variable.trim())
  .filter((variable) => variable !== "");
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
      CORRAL_STATUS_URL: process.env["CORRAL_STATUS_URL"],
      CORRAL_STATUS_TOKEN: process.env["CORRAL_STATUS_TOKEN"],
    },
    envSentinels: Object.fromEntries(
      loggedEnvNames.map((envName) => [envName, process.env[envName]]),
    ),
    opencode: name === "opencode" ? openCodePlugin() : undefined,
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

if (name === "pi" && rpcModeRequested(argv)) {
  startFakePiRpc(argv);
} else {
  startTuiFake();
}

/** `--mode rpc`, wherever it stands among the launch arguments. */
function rpcModeRequested(launchArgs: readonly string[]): boolean {
  const index = launchArgs.indexOf("--mode");
  return index >= 0 && launchArgs[index + 1] === "rpc";
}

function startTuiFake(): void {
  console.log(`fake ${name} ready`);

  // oxlint-disable-next-line no-control-regex -- the reply is an escape sequence
  const PROBE_REPLY = /\x1b\]7501;\?:states=[a-z,]+:kinds=[a-z,]+\x1b\\/;
  let awaitingProbeReply: string | undefined;
  let pending = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    if (awaitingProbeReply !== undefined) {
      pending += chunk;
      if (!PROBE_REPLY.test(pending)) return;
      pending = "";
      process.stdin.setRawMode(false);
      console.log(`fake ${name} probe answered`);
      process.stdout.write(`\x1b]7501;${awaitingProbeReply}\x1b\\`);
      awaitingProbeReply = undefined;
      return;
    }
    pending += chunk;
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
      const line = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      const exit = /^exit(?: (\d+))?$/.exec(line);
      if (exit) process.exit(Number(exit[1] ?? 0));
      const osc = /^osc (\S+)$/.exec(line);
      if (osc) {
        process.stdout.write(`\x1b]7501;${osc[1]}\x1b\\`);
        continue;
      }
      const probe = /^probe (\S+)$/.exec(line);
      if (probe) {
        // Raw mode, so the reply (which has no newline) reaches us unbuffered and unechoed.
        process.stdin.setRawMode(true);
        awaitingProbeReply = probe[1];
        process.stdout.write("\x1b]7501;?\x1b\\");
        continue;
      }
      const post = /^post (.+)$/.exec(line);
      if (post) {
        void postStatus(post[1]!);
        continue;
      }
      if (rolloutMode === "lazy") writeRolloutOnce();
      if (transcriptMode === "lazy") writeTranscriptOnce();
      console.log(`fake ${name} got: ${line}`);
    }
  });

  async function postStatus(json: string): Promise<void> {
    const response = await fetch(process.env["CORRAL_STATUS_URL"]!, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env["CORRAL_STATUS_TOKEN"]}`,
        "content-type": "application/json",
      },
      body: json,
    });
    console.log(`fake ${name} posted ${response.status}`);
  }
}
