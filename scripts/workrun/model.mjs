import { parseArgs } from "node:util";

export const ROOT_SLICE = "workrun.slice";
export const MANAGED = "# Managed by workrun.\n";
export const BUSY = 75;
export const DEFAULT_HEAVY_SLOTS = 1;

export function identifier(value, kind = "name") {
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(value ?? "")) {
    throw new Error(`${kind} must be 1–48 lowercase letters, digits, underscores or hyphens`);
  }
  return value;
}

// A literal hyphen would introduce another systemd slice hierarchy level.
function escape(value) {
  return identifier(value).replaceAll("-", "\\x2d");
}

export function sliceFor(group) {
  return `workrun-${escape(group)}.slice`;
}

export function unitFor(group, name) {
  return `workrun-${escape(group)}-${escape(name)}.service`;
}

export function jobFromUnit(unit) {
  const parts = /^workrun-([^-]+)-([^-]+)\.service$/.exec(unit);
  if (!parts) return undefined;
  const group = parts[1].replaceAll("\\x2d", "-");
  const name = parts[2].replaceAll("\\x2d", "-");
  try {
    return unitFor(group, name) === unit ? { group, name } : undefined;
  } catch {
    return undefined;
  }
}

export function heavySlots(value) {
  if (!/^[1-9]\d*$/.test(value ?? "") || !Number.isSafeInteger(Number(value))) {
    throw new Error("heavy-slots must be a positive integer");
  }
  return Number(value);
}

export function memoryBytes(value) {
  if (value === "inherit" || value === "infinity") return Infinity;
  if (!/^[1-9]\d*(?:[KMGT])?$/.test(value ?? "")) {
    throw new Error("memory limits must be positive integers, optionally suffixed K, M, G or T");
  }
  const suffix = /[KMGT]$/.exec(value)?.[0];
  const bytes = Number.parseInt(value, 10) * 1024 ** (suffix ? "KMGT".indexOf(suffix) + 1 : 0);
  if (!Number.isSafeInteger(bytes)) throw new Error("memory limit is too large");
  return bytes;
}

export function limits(high, max, root = false) {
  const h = memoryBytes(high);
  const m = memoryBytes(max);
  if (root && (!Number.isFinite(h) || !Number.isFinite(m))) {
    throw new Error("the shared budget requires finite memory-high and memory-max limits");
  }
  if (Number.isFinite(h) && h > m) throw new Error("memory-high must not exceed memory-max");
  return { high: h === Infinity ? "infinity" : high, max: m === Infinity ? "infinity" : max };
}

export function cpuPercent(value) {
  if (value === "inherit" || value === "") return Infinity;
  if (
    !/^[1-9]\d*%$/.test(value ?? "") ||
    !Number.isSafeInteger(Number.parseInt(value, 10) * 10_000)
  ) {
    throw new Error("cpu-quota must be a positive integer percentage, such as 600%, or inherit");
  }
  return Number.parseInt(value, 10);
}

export function parse(argv) {
  const separator = argv.indexOf("--");
  const command = separator < 0 ? [] : argv.slice(separator + 1);
  const { values, positionals } = parseArgs({
    args: separator < 0 ? argv : argv.slice(0, separator),
    allowPositionals: true,
    options: {
      group: { type: "string" },
      name: { type: "string" },
      heavy: { type: "boolean" },
      "no-wait": { type: "boolean" },
      "heavy-slots": { type: "string" },
      all: { type: "boolean" },
      json: { type: "boolean" },
      follow: { type: "boolean" },
      help: { type: "boolean" },
      "memory-high": { type: "string" },
      "memory-max": { type: "string" },
      "cpu-quota": { type: "string" },
    },
  });
  if (values.help) return { action: "help", values, command, positionals: [] };
  const action = positionals.shift();
  const budgets = ["memory-high", "memory-max", "cpu-quota"];
  const permitted = {
    setup: budgets,
    group: [...budgets, "heavy-slots"],
    run: ["group", "name", "heavy", "no-wait"],
    start: ["group", "heavy", "no-wait"],
    list: ["group", "json"],
    status: ["group", "json"],
    logs: ["group", "follow"],
    stop: ["group", "all"],
  };
  if (!permitted[action])
    throw new Error("expected setup, group set, run, start, list, status, logs or stop");
  for (const key of Object.keys(values)) {
    if (!permitted[action].includes(key)) throw new Error(`--${key} is not valid for ${action}`);
  }
  if (values.group !== undefined) identifier(values.group, "group");
  if (["run", "start", "status", "logs", "stop"].includes(action) && !values.group) {
    throw new Error(`${action} requires an explicit --group`);
  }
  if (values["heavy-slots"] !== undefined) heavySlots(values["heavy-slots"]);
  if (values["no-wait"] && !values.heavy) throw new Error("--no-wait requires --heavy");
  if (action === "run" || action === "start") {
    if (!command.length) throw new Error(`${action} requires -- followed by a command`);
    if (action === "start") {
      if (positionals.length !== 1) throw new Error("start requires a job name");
      identifier(positionals[0]);
    } else {
      if (positionals.length) throw new Error("run accepts its optional name through --name");
      if (values.name) identifier(values.name);
    }
  } else {
    if (separator >= 0) throw new Error(`${action} does not accept a command`);
    if (action === "group") {
      if (positionals.length !== 2 || positionals[0] !== "set")
        throw new Error("expected group set NAME");
      identifier(positionals[1], "group");
    } else if (action === "status" || action === "logs" || (action === "stop" && !values.all)) {
      if (positionals.length !== 1) throw new Error(`${action} requires one job name`);
      identifier(positionals[0]);
    } else if (positionals.length)
      throw new Error(`${action} does not accept positional arguments`);
    if (action === "setup" && (!values["memory-high"] || !values["memory-max"])) {
      throw new Error("setup requires --memory-high and --memory-max for the shared budget");
    }
    if (action === "group" && ![...budgets, "heavy-slots"].some((key) => values[key])) {
      throw new Error("group set requires a budget or --heavy-slots");
    }
  }
  return { action, values, command, positionals };
}
