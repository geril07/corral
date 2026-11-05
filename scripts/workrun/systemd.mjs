import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, stat, statfs, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import {
  BUSY,
  MANAGED,
  ROOT_SLICE,
  jobFromUnit,
  cpuPercent,
  limits,
  memoryBytes,
  sliceFor,
  unitFor,
} from "./model.mjs";

const execute = promisify(execFile);
const ctl = (...args) => capture("systemctl", ["--user", "--no-pager", ...args]);

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
    "--property=Id,LoadState,ActiveState,SubState,Description,Slice,ControlGroup,MainPID,Result,ExecMainCode,ExecMainStatus,MemoryCurrent,MemoryPeak,MemoryHigh,MemoryMax,EffectiveMemoryMax,CPUUsageNSec,CPUQuotaPerSecUSec",
  );
  return Object.fromEntries(
    raw.split("\n").map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }),
  );
}

export async function jobs(scope) {
  const all = JSON.parse(await ctl("list-units", "--all", "--output=json", "workrun-*.service"));
  const result = [];
  for (const item of all) {
    const job = jobFromUnit(item.unit);
    if (!job || (scope !== undefined && job.scope !== scope)) continue;
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
  return `workrun ${heavy ? "heavy " : ""}${job.scope}/${job.name}`;
}

async function existingLimits(unit) {
  let content;
  try {
    content = await readFile(join(configDirectory(), unit), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { high: "infinity", max: "infinity", cpu: "" };
    throw error;
  }
  if (!content.startsWith(MANAGED)) throw new Error(`refusing to replace unmanaged ${unit}`);
  return {
    high: /^MemoryHigh=(.+)$/m.exec(content)?.[1] ?? "infinity",
    max: /^MemoryMax=(.+)$/m.exec(content)?.[1] ?? "infinity",
    cpu: /^CPUQuota=(.*)$/m.exec(content)?.[1] ?? "",
  };
}

export async function configure(scope, high, max, cpu) {
  const unit = scope === undefined ? ROOT_SLICE : sliceFor(scope);
  const previous = await existingLimits(unit);
  const selected = cpu ?? previous.cpu;
  const budget = {
    ...limits(high ?? previous.high, max ?? previous.max, scope === undefined),
    cpu: cpuPercent(selected) === Infinity ? "" : selected,
  };
  await mkdir(configDirectory(), { recursive: true, mode: 0o700 });
  const path = join(configDirectory(), unit);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    `${MANAGED}[Unit]\nDescription=workrun ${scope ?? "shared budget"}\n\n[Slice]\nMemoryAccounting=yes\nCPUAccounting=yes\nMemoryHigh=${budget.high}\nMemoryMax=${budget.max}\nCPUQuota=${budget.cpu}\n`,
    { mode: 0o600 },
  );
  await rename(temporary, path);
  await ctl("daemon-reload");
  await ctl("start", unit);
  // Updating an already active slice must apply now, not only after its next activation.
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
      // The kernel rounds byte limits to whole pages.
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

export async function ready(scope) {
  const root = await existingLimits(ROOT_SLICE);
  limits(root.high, root.max, true);
  await ctl("start", ROOT_SLICE);
  await verifyBudget(ROOT_SLICE, root);
  await ctl("start", sliceFor(scope));
  const own = await existingLimits(sliceFor(scope));
  await verifyBudget(sliceFor(scope), own);
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

export async function lockPath() {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (!runtime || !isAbsolute(runtime))
    throw new Error("XDG_RUNTIME_DIR must name the user's runtime directory");
  const info = await stat(runtime);
  if (info.uid !== process.getuid() || info.mode & 0o077) {
    throw new Error("XDG_RUNTIME_DIR must be private and owned by the current user");
  }
  // Never unlink: replacing an inode would let two worktrees hold different locks.
  return join(runtime, "workrun-heavy.lock");
}

export async function stopUnit(unit) {
  await ctl("stop", unit);
  await ctl("reset-failed", unit).catch(() => {});
}

export async function stop(scope, name, all = false) {
  const selected = (await jobs(scope)).filter((job) => all || job.name === name);
  if (!all && !selected.length) throw new Error(`no managed job ${scope}/${name}`);
  await Promise.all(selected.map((job) => stopUnit(job.unit)));
  return selected.length;
}

export async function inspect(scope, name) {
  const job = (await jobs(scope)).find((each) => each.name === name);
  if (!job) throw new Error(`no managed job ${scope}/${name}; completed output remains in logs`);
  return { ...job, ...(await properties(job.unit)) };
}

export async function launch({ scope, name, command, heavy, background }) {
  await ready(scope);
  if (heavy) {
    // flock serializes admission. systemd's cgroup lifetime holds the slot after a background
    // launcher exits, including deactivation and descendants whose original parent has exited.
    const occupied = (await jobs()).find(
      (job) => job.heavy && !["inactive", "failed"].includes(job.state),
    );
    if (occupied) {
      const error = new Error(`heavy slot busy: ${occupied.scope}/${occupied.name}`);
      error.exitCode = BUSY;
      throw error;
    }
  }
  const unit = unitFor(scope, name);
  const program = await executable(command[0]);
  const args = [
    "--user",
    `--unit=${unit}`,
    `--slice=${sliceFor(scope)}`,
    `--description=${description({ scope, name }, heavy)}`,
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
  ];
  // Pass variable names, not secret values in argv. systemd-run reads them from this environment.
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
    // A nested invocation must receive its own systemd identity and sockets, not its parent's.
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !serviceEnvironment.has(key))
      args.push(`--setenv=${key}`);
  }
  if (background)
    args.push("--property=StandardOutput=journal", "--property=StandardError=journal");
  else args.push("--wait", "--pipe", "--pty", "--collect");
  args.push("--", program, ...command.slice(1));
  if (background) {
    await capture("systemd-run", args);
    return 0;
  }
  return foreground("systemd-run", args, unit);
}

export async function foreground(program, args, unit) {
  const child = spawn(program, args, { stdio: "inherit", detached: true });
  let interrupted;
  let stopping = Promise.resolve();
  const handlers = new Map(
    ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [
      signal,
      () => {
        if (!interrupted) {
          interrupted = signal;
          stopping = stopUnit(unit).catch(() => {});
        }
        // Cancel a launcher still admitting the job too; the service itself is in a separate cgroup.
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
        } catch {
          /* The launcher already exited. */
        }
      },
    ]),
  );
  for (const [signal, handler] of handlers) process.on(signal, handler);
  try {
    const code = await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (value, signal) =>
        resolveExit(value ?? (signal ? 128 + constantsForSignal(signal) : 1)),
      );
    });
    await stopping;
    if (interrupted) {
      await stopUnit(unit).catch(() => {});
      return 128 + constantsForSignal(interrupted);
    }
    return code;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  }
}

function constantsForSignal(signal) {
  return { SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 }[signal] ?? 1;
}

export async function logs(scope, name, follow) {
  const args = ["--user", "--unit", unitFor(scope, name), "--no-pager", "--output=cat"];
  if (follow) args.push("--follow");
  const child = spawn("journalctl", args, { stdio: "inherit" });
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code ?? 1));
  });
}
