#!/usr/bin/env node
// The checkout's dev stack, isolated from the installed app: state, data and config live in
// `.dev/`, so a development server cannot take the packaged app's single-instance lock, database
// or config file (`engineering.md`, **Two directories, two keys**). `pnpm dev` and
// `pnpm dev:desktop` both come through here, so those three paths have one definition and do not
// depend on the shell having mise activated.
import { spawn } from "node:child_process";
import { join } from "node:path";

const repository = join(import.meta.dirname, "..");
const env = {
  ...process.env,
  CORRAL_STATE_DIR: join(repository, ".dev", "state"),
  CORRAL_DATA_DIR: join(repository, ".dev", "data"),
  CORRAL_CONFIG_DIR: join(repository, ".dev", "config"),
};

// `--desktop` loads the running web dev server in Electron instead of starting the stack, so the
// page keeps its hot reload; the server endpoint still reaches it over the preload bridge.
const desktop = process.argv.includes("--desktop");
const [args, childEnv] = desktop
  ? [
      ["run", "@corral/desktop#start"],
      { ...env, CORRAL_WEB_URL: env["CORRAL_WEB_URL"] ?? "http://localhost:5173" },
    ]
  : [
      // Not `-r`: it also selects this very script as `corral#dev`, which would run itself again.
      ["run", "--parallel", "--filter", "./apps/*", "dev"],
      env,
    ];

const child = spawn("vp", args, { cwd: repository, env: childEnv, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
