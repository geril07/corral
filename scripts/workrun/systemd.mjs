/* eslint-disable no-await-in-loop -- Admission observes one systemd state transition before advancing. */
import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, stat, statfs, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { busy, withGroupLock } from "./admission.mjs";
import {
  DEFAULT_HEAVY_SLOTS,
  MANAGED,
  ROOT_SLICE,
  jobFromUnit,
  cpuPercent,
  heavySlots,
  limits,
  memoryBytes,
  sliceFor,
  unitFor,
} from "./model.mjs";

const execute = promisify(execFile);
const ctl = (...args) => capture("systemctl", ["--user", "--no-pager", ...args]);
const live = (job) => !["inactive", "failed"].includes(job.state);

export async function capture(command, args) {
  try {
    const { stdout } = await execute(command, args, { maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    throw new Error(
      error.stderr?.trim() || `${command} failed (exit ${error.code}); inspect the unit journal`,
      { cause: error },
    );
  }
}

function configDirectory() {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  if (!isAbsolute(base)) throw new Error("XDG_CONFIG_HOME must be absolute");
  return join(base, "systemd", "user");
}

export async function prerequisites() {
  if (process.platform !== "linux" || (await statfs("/sys/fs/cgroup")).type !== 0x63677270) {
    throw new Error("workrun requires Linux with cgroup v2");
  }
  const version = await ctl("show", "--property=Version", "--value");
  if (Number.parseInt(version, 10) < 254) throw new Error("workrun requires systemd 254 or newer");
  await capture("flock", ["--version"]);
}

export async function properties(unit) {
  const raw = await ctl(
    "show",
    unit,
    "--property=Id,LoadState,ActiveState,SubState,Description,Slice,ControlGroup,MainPID,Result,ExecMainCode,ExecMainStatus,MemoryCurrent,MemoryPeak,MemoryHigh,MemoryMax,EffectiveMemoryMax,CPUUsageNSec,CPUQuotaPerSecUSec,SyslogIdentifier",
  );
  return Object.fromEntries(
    raw.split("\n").map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }),
  );
}

export async function jobs(group) {
  const all = JSON.parse(await ctl("list-units", "--all", "--output=json", "workrun-*.service"));
  const result = [];
  for (const item of all) {
    const job = jobFromUnit(item.unit);
    if (!job || (group !== undefined && job.group !== group)) continue;
    if (![description(job, false), description(job, true)].includes(item.description)) continue;
    result.push({
      ...job,
      unit: item.unit,
      state: item.active,
      substate: item.sub,
      heavy: item.description === description(job, true),
    });
  }
  return result;
}

function description(job, heavy) {
  return `workrun ${heavy ? "heavy " : ""}${job.group}/${job.name}`;
}

export async function existingLimits(unit) {
  let content;
  try {
    content = await readFile(join(configDirectory(), unit), "utf8");
  } catch (error) {
    if (error.code === "ENOENT")
      return { high: "infinity", max: "infinity", cpu: "", heavySlots: DEFAULT_HEAVY_SLOTS };
    throw error;
  }
  if (!content.startsWith(MANAGED)) throw new Error(`refusing to replace unmanaged ${unit}`);
  return {
    high: /^MemoryHigh=(.+)$/m.exec(content)?.[1] ?? "infinity",
    max: /^MemoryMax=(.+)$/m.exec(content)?.[1] ?? "infinity",
    cpu: /^CPUQuota=(.*)$/m.exec(content)?.[1] ?? "",
    heavySlots: heavySlots(
      /^# HeavySlots=(.+)$/m.exec(content)?.[1] ?? String(DEFAULT_HEAVY_SLOTS),
    ),
  };
}

async function activateSlice(unit) {
  // Even a redundant start can wait behind a child's stop transaction. Admission must still
  // observe that child's deactivating cgroup instead of silently waiting for its slot to clear.
  if ((await properties(unit)).ActiveState !== "active") await ctl("start", unit);
}

export async function configure(group, high, max, cpu, slots) {
  const change = async () => {
    const unit = group === undefined ? ROOT_SLICE : sliceFor(group);
    const previous = await existingLimits(unit);
    const selected = cpu ?? previous.cpu;
    const budget = {
      ...limits(high ?? previous.high, max ?? previous.max, group === undefined),
      cpu: cpuPercent(selected) === Infinity ? "" : selected,
      heavySlots: slots === undefined ? previous.heavySlots : heavySlots(slots),
    };
    await mkdir(configDirectory(), { recursive: true, mode: 0o700 });
    const path = join(configDirectory(), unit);
    const temporary = `${path}.${randomUUID()}.tmp`;
    // Keep admission settings beside their group's budget, not in a second configuration store.
    const admission = group === undefined ? "" : `# HeavySlots=${budget.heavySlots}\n`;
    await writeFile(
      temporary,
      `${MANAGED}${admission}[Unit]\nDescription=workrun ${group ?? "shared budget"}\n\n[Slice]\nMemoryAccounting=yes\nCPUAccounting=yes\nMemoryHigh=${budget.high}\nMemoryMax=${budget.max}\nCPUQuota=${budget.cpu}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, path);
    await ctl("daemon-reload");
    await activateSlice(unit);
    await ctl(
      "set-property",
      "--runtime",
      unit,
      `MemoryHigh=${budget.high}`,
      `MemoryMax=${budget.max}`,
      `CPUQuota=${budget.cpu}`,
    );
    await verifyBudget(unit, budget);
    return budget;
  };
  if (group === undefined) return change();
  return withGroupLock(group, change);
}

async function verifyBudget(unit, expected) {
  const actual = await properties(unit);
  if (actual.LoadState !== "loaded" || !actual.ControlGroup)
    throw new Error(`${unit} is not active`);
  const path = join("/sys/fs/cgroup", actual.ControlGroup);
  await Promise.all(
    [
      ["memory.high", expected.high],
      ["memory.max", expected.max],
    ].map(async ([file, value]) => {
      const raw = (await readFile(join(path, file), "utf8")).trim();
      const wanted = memoryBytes(value);
      const observed = Number(raw);
      if (
        wanted === Infinity
          ? raw !== "max"
          : !Number.isFinite(observed) || Math.abs(observed - wanted) >= 65536
      ) {
        throw new Error(`${unit}: kernel ${file}=${raw} does not match ${value}`);
      }
    }),
  );
  const wantedCPU = cpuPercent(expected.cpu);
  if (wantedCPU !== Infinity) {
    const [quota, period] = (await readFile(join(path, "cpu.max"), "utf8"))
      .trim()
      .split(/\s+/)
      .map(Number);
    if (!Number.isFinite(quota) || Math.abs((quota / period) * 100 - wantedCPU) > 0.01) {
      throw new Error(`${unit}: kernel cpu.max does not match ${expected.cpu}`);
    }
  }
}

export async function ready(group) {
  const root = await existingLimits(ROOT_SLICE);
  limits(root.high, root.max, true);
  await activateSlice(ROOT_SLICE);
  await verifyBudget(ROOT_SLICE, root);
  await activateSlice(sliceFor(group));
  const own = await existingLimits(sliceFor(group));
  await verifyBudget(sliceFor(group), own);
  return own;
}

async function executable(command) {
  const candidates = command.includes("/")
    ? [resolve(command)]
    : (process.env.PATH ?? "").split(delimiter).map((dir) => resolve(dir, command));
  const available = await Promise.all(
    candidates.map(async (path) => {
      try {
        await access(path, constants.X_OK);
        return (await stat(path)).isFile();
      } catch {
        return false;
      }
    }),
  );
  const at = available.indexOf(true);
  if (at < 0) throw new Error(`executable not found: ${command}`);
  return candidates[at];
}

export async function stopUnit(unit) {
  await ctl("stop", unit);
  await ctl("reset-failed", unit).catch(() => {});
}

export async function stop(group, name, all = false) {
  const selected = (await jobs(group)).filter((job) => all || job.name === name);
  if (!all && !selected.length) throw new Error(`no managed job ${group}/${name}`);
  await Promise.all(selected.map((job) => stopUnit(job.unit)));
  return selected.length;
}

export async function inspect(group, name) {
  const job = (await jobs(group)).find((each) => each.name === name);
  if (!job) throw new Error(`no managed job ${group}/${name}; completed output remains in logs`);
  return { ...job, ...(await properties(job.unit)) };
}

export async function launch({ group, name, command, heavy, background, noWait = false }) {
  const unit = unitFor(group, name);
  const identity = `workrun-${randomUUID()}`;
  const controller = new AbortController();
  const { signal } = controller;
  let interrupted;
  let running;
  let succeeded = false;
  const handlers = new Map(
    ["SIGINT", "SIGTERM", "SIGHUP"].map((value) => [
      value,
      () => {
        interrupted ??= value;
        controller.abort();
      },
    ]),
  );
  const stopOwned = async () => {
    const current = await properties(unit);
    // Cancellation of a waiter or a duplicate-name attempt must never stop somebody else's job.
    if (current.SyslogIdentifier === identity) await stopUnit(unit);
  };
  for (const [value, handler] of handlers) process.on(value, handler);
  try {
    const program = await executable(command[0]);
    let announced = false;
    while (!running) {
      signal.throwIfAborted();
      running = await withGroupLock(
        group,
        async () => {
          signal.throwIfAborted();
          const budget = await ready(group);
          const current = await jobs(group);
          if (
            heavy &&
            current.filter((job) => job.heavy && live(job)).length >= budget.heavySlots
          ) {
            if (noWait) throw busy(group);
            return undefined;
          }
          if (current.some((job) => job.name === name))
            throw new Error(`job already exists: ${group}/${name}`);
          signal.throwIfAborted();
          const args = serviceArguments({
            group,
            name,
            program,
            command,
            heavy,
            background,
            identity,
          });
          signal.throwIfAborted();
          running = runLauncher(args, background, signal);
          // Release admission only after systemd exposes the unit, or the launcher has finished.
          // Foreground jobs must not hold this mutex for their whole lifetime when slots > 1.
          while (!running.finished) {
            signal.throwIfAborted();
            const currentUnit = await properties(unit);
            if (
              currentUnit.SyslogIdentifier === identity &&
              ["active", "activating", "deactivating"].includes(currentUnit.ActiveState)
            )
              break;
            await delay(25, undefined, { signal });
          }
          return running;
        },
        { signal },
      );
      if (!running) {
        if (!announced) {
          console.error(`workrun: waiting for a heavy slot in ${group}`);
          announced = true;
        }
        // systemd owns live capacity, including descendants after their launcher exits. Recheck
        // with a cancellable timer, outside the admission lock, so settings and peers can advance.
        await delay(250, undefined, { signal });
      }
    }
    const result = await running.done;
    signal.throwIfAborted();
    if (result.error) throw result.error;
    if (background && result.code !== 0)
      throw new Error(result.stderr.trim() || `systemd-run failed (exit ${result.code})`);
    succeeded = true;
    return result.code;
  } catch (error) {
    if (!interrupted) throw error;
    return 128 + signalNumber(interrupted);
  } finally {
    if (!succeeded) {
      controller.abort();
      await stopOwned().catch(() => {});
      if (running) await running.done;
      await stopOwned().catch(() => {});
    }
    for (const [value, handler] of handlers) process.off(value, handler);
  }
}

function serviceArguments({ group, name, program, command, heavy, background, identity }) {
  const args = [
    "--user",
    `--unit=${unitFor(group, name)}`,
    `--slice=${sliceFor(group)}`,
    `--description=${description({ group, name }, heavy)}`,
    "--service-type=exec",
    "--expand-environment=no",
    "--quiet",
    `--working-directory=${process.cwd()}`,
    "--property=ExitType=cgroup",
    "--property=KillMode=control-group",
    "--property=TimeoutStopSec=5s",
    "--property=OOMPolicy=kill",
    "--property=MemoryAccounting=yes",
    "--property=Restart=no",
    `--property=SyslogIdentifier=${identity}`,
  ];
  const serviceEnvironment = new Set([
    "INVOCATION_ID",
    "SYSTEMD_EXEC_PID",
    "JOURNAL_STREAM",
    "MEMORY_PRESSURE_WATCH",
    "MEMORY_PRESSURE_WRITE",
    "NOTIFY_SOCKET",
    "LISTEN_PID",
    "LISTEN_FDS",
    "LISTEN_FDNAMES",
    "WATCHDOG_PID",
    "WATCHDOG_USEC",
  ]);
  for (const key of Object.keys(process.env)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !serviceEnvironment.has(key))
      args.push(`--setenv=${key}`);
  }
  if (background)
    args.push("--property=StandardOutput=journal", "--property=StandardError=journal");
  else args.push("--wait", "--pipe", "--pty", "--collect");
  args.push("--", program, ...command.slice(1));
  return args;
}

function runLauncher(args, background, signal) {
  const child = spawn("systemd-run", args, {
    stdio: background ? ["ignore", "pipe", "pipe"] : "inherit",
    detached: true,
  });
  const running = { finished: false, done: undefined };
  let stderr = "";
  if (background) {
    child.stdout.resume();
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-8192);
    });
  }
  const cancel = () => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
    } catch {
      /* The launcher already exited; launch() still stops its owned systemd unit. */
    }
  };
  signal.addEventListener("abort", cancel, { once: true });
  running.done = new Promise((resolveExit) => {
    child.once("error", (error) => resolveExit({ error }));
    child.once("exit", (code, value) =>
      resolveExit({ code: code ?? (value ? 128 + signalNumber(value) : 1), stderr }),
    );
  }).then((result) => {
    running.finished = true;
    signal.removeEventListener("abort", cancel);
    return result;
  });
  return running;
}

function signalNumber(signal) {
  return { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 }[signal] ?? 1;
}

export async function logs(group, name, follow) {
  const args = ["--user", "--unit", unitFor(group, name), "--no-pager", "--output=cat"];
  if (follow) args.push("--follow");
  const child = spawn("journalctl", args, { stdio: "inherit" });
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
}
