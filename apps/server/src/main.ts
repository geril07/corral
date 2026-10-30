import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "@corral/protocol/handshake";
import {
  resolveDataDir,
  resolveStateDir,
  SERVER_LOCK_REFUSED_EXIT_CODE,
} from "@corral/protocol/server-endpoint";
import { publishEndpoint, type PublishedEndpoint } from "./lifecycle/endpoint.ts";
import { acquireLock } from "./lifecycle/lock.ts";
import { startServer, type RunningServer } from "./transport/server.ts";

const LOCK_CHECK_INTERVAL_MS = 2000;

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "0" },
  },
});

const stateDir = resolveStateDir(process.env, homedir());
mkdirSync(stateDir, { recursive: true, mode: 0o700 });

const acquired = acquireLock(stateDir);
if (acquired.status === "refused") {
  console.error(`corral-server: not starting: ${acquired.reason}`);
  process.exit(SERVER_LOCK_REFUSED_EXIT_CODE);
}
const { lock } = acquired;

let server: RunningServer | undefined;
let endpoint: PublishedEndpoint | undefined;

// Runs on every way out (signals, uncaught errors); SIGKILL leaves a lock the next start recovers.
process.once("exit", () => {
  endpoint?.remove();
  lock.release();
});

function shutdown(exitCode: number) {
  endpoint?.remove();
  void (server?.close() ?? Promise.resolve()).then(() => process.exit(exitCode));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => shutdown(0));

server = await startServer({
  host: values.host,
  port: Number(values.port),
  dataDir: resolveDataDir(process.env, homedir()),
});

// Two starters that both proved a dead lock dead can replace each other's file; the one whose
// file is gone stands down, and no server keeps running without the lock.
function standDownIfLockLost() {
  if (lock.ownership() !== "lost") return false;
  console.error("corral-server: lost the single-instance lock; exiting");
  shutdown(1);
  return true;
}

if (!standDownIfLockLost()) {
  endpoint = publishEndpoint(stateDir, {
    pid: process.pid,
    url: server.url,
    protocolVersion: PROTOCOL_VERSION,
    startedAt: Date.now(),
  });
  // Parents (desktop app, tests) wait for this line to learn the URL.
  console.log(`corral-server listening ${server.url}`);
  setInterval(standDownIfLockLost, LOCK_CHECK_INTERVAL_MS).unref();
}
