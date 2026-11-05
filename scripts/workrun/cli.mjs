#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parse, unitFor } from "./model.mjs";
import {
  configure,
  foreground,
  inspect,
  jobs,
  launch,
  lockPath,
  logs,
  prerequisites,
  ready,
  stop,
} from "./systemd.mjs";

const HELP = `workrun — scoped commands under a shared systemd resource budget (Linux)

  setup --memory-high SIZE --memory-max SIZE [--cpu-quota PERCENT]
  scope set SCOPE [--memory-high SIZE] [--memory-max SIZE] [--cpu-quota PERCENT]
  --scope SCOPE run [--name NAME] [--heavy] -- COMMAND [ARGS...]
  --scope SCOPE start NAME [--heavy] -- COMMAND [ARGS...]
  [--scope SCOPE] list [--json]
  --scope SCOPE status NAME [--json]
  --scope SCOPE logs NAME [--follow]
  --scope SCOPE stop NAME | stop --all

Sizes: positive bytes or K/M/G/T (base 1024); scope limits also accept inherit.
CPU quota: positive integer percentage (600% = six CPUs); inherit removes the local cap.
Heavy admission is nonblocking; busy exits 75. No command runs without a budget.
run waits for the whole process group; start returns after exec, not app readiness.
`;

async function main() {
  const argv = process.argv.slice(2);
  const locked = argv[0] === "--_heavy-lock";
  if (locked) argv.shift();
  const request = parse(argv);
  const { action, values, positionals, command } = request;
  if (action === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  await prerequisites();
  switch (action) {
    case "setup": {
      const budget = await configure(
        undefined,
        values["memory-high"],
        values["memory-max"],
        values["cpu-quota"],
      );
      console.log(
        `Shared budget: high=${budget.high}, max=${budget.max}, cpu=${budget.cpu || "inherit"}`,
      );
      return 0;
    }
    case "scope": {
      const scope = positionals[1];
      await ready(scope);
      const budget = await configure(
        scope,
        values["memory-high"],
        values["memory-max"],
        values["cpu-quota"],
      );
      console.log(
        `${scope}: high=${budget.high}, max=${budget.max}, cpu=${budget.cpu || "inherit"} (also constrained by the shared budget)`,
      );
      return 0;
    }
    case "run":
    case "start": {
      const name = action === "start" ? positionals[0] : (values.name ?? `run-${randomUUID()}`);
      const unit = unitFor(values.scope, name);
      if (values.heavy && !locked) {
        const forwarded = [...argv];
        if (action === "run" && !values.name)
          forwarded.splice(forwarded.indexOf("--"), 0, "--name", name);
        const args = [
          "--nonblock",
          "--conflict-exit-code=75",
          "--close",
          await lockPath(),
          process.execPath,
          fileURLToPath(import.meta.url),
          "--_heavy-lock",
          ...forwarded,
        ];
        // The admission lock is common to all checkouts; background services retain the slot in
        // systemd state after this flock process exits. No custom persistent supervisor is needed.
        const code = await foreground("flock", args, unit);
        if (code === 75)
          console.error(
            "workrun: heavy slot busy (or command exited 75); retry after the current job finishes",
          );
        return code;
      }
      console.error(`workrun: ${values.scope}/${name}`);
      const code = await launch({
        scope: values.scope,
        name,
        command,
        heavy: Boolean(values.heavy),
        background: action === "start",
      });
      return code;
    }
    case "list": {
      const found = await jobs(values.scope);
      if (values.json) console.log(JSON.stringify(found));
      else {
        console.log("SCOPE\tNAME\tSTATE\tHEAVY");
        for (const job of found)
          console.log(
            `${job.scope}\t${job.name}\t${job.state}/${job.substate}\t${job.heavy ? "yes" : "no"}`,
          );
      }
      return 0;
    }
    case "status": {
      const job = await inspect(values.scope, positionals[0]);
      if (values.json) console.log(JSON.stringify(job));
      else
        console.log(
          `${job.scope}/${job.name}: ${job.state}/${job.substate}\n` +
            `PID: ${job.MainPID}; result: ${job.Result}; exit: ${job.ExecMainStatus}\n` +
            `Memory: ${job.MemoryCurrent}; peak: ${job.MemoryPeak}; effective max: ${job.EffectiveMemoryMax}\n` +
            `CPU time: ${job.CPUUsageNSec} ns\n` +
            `Cgroup: ${job.ControlGroup}`,
        );
      return 0;
    }
    case "logs":
      return logs(values.scope, positionals[0], values.follow);
    case "stop": {
      const count = await stop(values.scope, positionals[0], values.all);
      console.log(`Stopped ${count} job(s) in ${values.scope}`);
      return 0;
    }
    default:
      throw new Error(`unsupported action: ${action}`);
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  // execFile's message can contain the full command line; stderr is the actionable systemd error.
  console.error(`workrun: ${error.stderr?.trim() || error.message}`);
  if (error.message?.includes("shared budget requires finite")) {
    console.error("Run workrun setup --memory-high 10G --memory-max 12G first.");
  }
  process.exitCode = error.exitCode ?? 1;
}
