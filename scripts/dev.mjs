#!/usr/bin/env node
// The checkout's dev stack, isolated from the installed app: state, data and config live in
// `.dev/`, so a development server cannot take the packaged app's single-instance lock, database
// or config file (`engineering.md`, **Two directories, two keys**). `pnpm dev` and
// `pnpm dev:desktop` both come through here, so those three paths have one definition and do not
// depend on the shell having mise activated.
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const repository = join(import.meta.dirname, "..");
const endpointPath = join(repository, ".dev", "state", "endpoint.json");
const env = {
  ...process.env,
  CORRAL_STATE_DIR: join(repository, ".dev", "state"),
  CORRAL_DATA_DIR: join(repository, ".dev", "data"),
  CORRAL_CONFIG_DIR: join(repository, ".dev", "config"),
};

// `--desktop` loads the running web dev server in Electron instead of starting the stack, so the
// page keeps its hot reload; the server endpoint still reaches it over the preload bridge.
const desktop = process.argv.includes("--desktop");
const webUrl = env["CORRAL_WEB_URL"] ?? "http://localhost:5173";
const [args, childEnv] = desktop
  ? [["run", "@corral/desktop#start"], { ...env, CORRAL_WEB_URL: webUrl }]
  : [
      // Not `-r`: it also selects this very script as `corral#dev`, which would run itself again.
      ["run", "--parallel", "--filter", "./apps/*", "dev"],
      env,
    ];

const child = spawn("vp", args, { cwd: repository, env: childEnv, stdio: "inherit" });
// A closed terminal or `tmux kill-session` sends SIGHUP to this process alone, so it is forwarded
// with the two Ctrl-C signals; otherwise the dev tasks outlive the window that started them.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));

if (!desktop) void announceBrowserUrl();

/**
 * Prints the page URL once the server publishes its endpoint, and again whenever `node --watch`
 * restarts it with a new capability. The window URL carries no token; this link is the one place
 * the dev page learns it (like pasting from `endpoint.json`, without the copying).
 */
async function announceBrowserUrl() {
  let announced;
  for (;;) {
    const endpoint = await publishedEndpoint();
    if (endpoint !== undefined && endpoint.capability !== announced) {
      announced = endpoint.capability;
      const url = new URL(webUrl);
      url.searchParams.set("server", endpoint.url);
      url.hash = `/?capability=${endpoint.capability}`;
      console.log(`\ncorral dev: ${url}\n`);
      if (!(await servesApp(webUrl))) {
        console.log(
          `corral dev: nothing is serving the app at ${webUrl}, so the web task may have taken ` +
            "another port; rerun with CORRAL_WEB_URL set to that port.\n",
        );
      }
    }
    await sleep(500);
  }
}

async function publishedEndpoint() {
  let raw;
  try {
    raw = await readFile(endpointPath, "utf8");
  } catch {
    return undefined;
  }
  try {
    const endpoint = JSON.parse(raw);
    if (typeof endpoint.capability !== "string" || typeof endpoint.url !== "string") {
      return undefined;
    }
    // A killed run leaves its file behind; only a live pid published a capability we can use.
    process.kill(endpoint.pid, 0);
    return endpoint;
  } catch {
    return undefined;
  }
}

async function servesApp(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return response.ok && (await response.text()).includes("<title>Corral</title>");
  } catch {
    return false;
  }
}
