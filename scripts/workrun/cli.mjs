#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { parse } from "./model.mjs";
import { configure, inspect, jobs, launch, logs, prerequisites, ready, stop } from "./systemd.mjs";

const HELP = `workrun — grouped commands under a shared systemd resource budget (Linux)

  setup --memory-high SIZE --memory-max SIZE [--cpu-quota PERCENT]
  group set GROUP [--heavy-slots N] [--memory-high SIZE] [--memory-max SIZE] [--cpu-quota PERCENT]
  --group GROUP run [--name JOB] [--heavy [--no-wait]] -- COMMAND [ARGS...]
  --group GROUP start JOB [--heavy [--no-wait]] -- COMMAND [ARGS...]
  [--group GROUP] list [--json]
  --group GROUP status JOB [--json]
  --group GROUP logs JOB [--follow]
  --group GROUP stop JOB | stop --all

Sizes: positive bytes or K/M/G/T (base 1024); group limits also accept inherit.
CPU quota: positive integer percentage (400% = four CPUs); inherit removes the local cap.
Each group has one heavy slot by default. --heavy waits; --no-wait reports contention as 75.
Waiting is cancellable, not a durable/FIFO queue. A payload may itself exit 75.
No command runs without a budget. run waits for the entire job; start returns after exec,
not app readiness. A group normally represents a project; job names distinguish worktrees.
`;

async function main() {
  const { action, values, positionals, command } = parse(process.argv.slice(2));
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
    case "group": {
      const group = positionals[1];
      await ready(group);
      const budget = await configure(
        group,
        values["memory-high"],
        values["memory-max"],
        values["cpu-quota"],
        values["heavy-slots"],
      );
      console.log(
        `${group}: heavy-slots=${budget.heavySlots}, high=${budget.high}, max=${budget.max}, cpu=${budget.cpu || "inherit"} (also constrained by the shared budget)`,
      );
      return 0;
    }
    case "run":
    case "start": {
      const name = action === "start" ? positionals[0] : (values.name ?? `run-${randomUUID()}`);
      console.error(`workrun: ${values.group}/${name}`);
      return launch({
        group: values.group,
        name,
        command,
        heavy: Boolean(values.heavy),
        background: action === "start",
        noWait: Boolean(values["no-wait"]),
      });
    }
    case "list": {
      const found = await jobs(values.group);
      if (values.json) console.log(JSON.stringify(found));
      else {
        console.log("GROUP\tJOB\tSTATE\tHEAVY");
        for (const job of found)
          console.log(
            `${job.group}\t${job.name}\t${job.state}/${job.substate}\t${job.heavy ? "yes" : "no"}`,
          );
      }
      return 0;
    }
    case "status": {
      const job = await inspect(values.group, positionals[0]);
      if (values.json) console.log(JSON.stringify(job));
      else
        console.log(
          `${job.group}/${job.name}: ${job.state}/${job.substate}\n` +
            `PID: ${job.MainPID}; result: ${job.Result}; exit: ${job.ExecMainStatus}\n` +
            `Memory: ${job.MemoryCurrent}; peak: ${job.MemoryPeak}; effective max: ${job.EffectiveMemoryMax}\n` +
            `CPU time: ${job.CPUUsageNSec} ns\n` +
            `Cgroup: ${job.ControlGroup}`,
        );
      return 0;
    }
    case "logs":
      return logs(values.group, positionals[0], values.follow);
    case "stop": {
      const count = await stop(values.group, positionals[0], values.all);
      console.log(`Stopped ${count} job(s) in ${values.group}`);
      return 0;
    }
    default:
      throw new Error(`unsupported action: ${action}`);
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`workrun: ${error.stderr?.trim() || error.message}`);
  if (error.message?.includes("shared budget requires finite")) {
    console.error("Run workrun setup --memory-high SIZE --memory-max SIZE first.");
  }
  process.exitCode = error.exitCode ?? 1;
}
