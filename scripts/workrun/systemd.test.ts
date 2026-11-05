/* eslint-disable no-await-in-loop -- Lifecycle probes and teardown observe each state before advancing. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { capture, jobs, properties } from "./systemd.mjs";
import { sliceFor, unitFor } from "./model.mjs";

const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const enabled = process.env.WORKRUN_SYSTEMD_TEST === "1";
const scope = `test-${randomUUID().slice(0, 8)}`;
const other = `${scope}-other`;
const children = new Set<ChildProcess>();
let directory: string;

function command(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: options.cwd ?? directory,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        children.delete(child);
        resolve({ code, stdout, stderr });
      });
    },
  );
  return { child, done };
}

async function invoke(args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  return command(args, options).done;
}

async function successful(args: string[]) {
  const result = await invoke(args);
  expect(result).toMatchObject({ code: 0 });
  return result;
}

async function until<T>(probe: () => Promise<T>, predicate: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (true) {
    const value = await probe();
    if (predicate(value)) return value;
    if (Date.now() >= deadline)
      throw new Error(`observable condition timed out: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function file(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function status(name: string, target = scope) {
  const result = await invoke(["--scope", target, "status", name, "--json"]);
  return result.code === 0 ? JSON.parse(result.stdout) : undefined;
}

const hold = "setInterval(() => {}, 1000)";

describe.skipIf(!enabled)(
  "workrun through real user systemd (opt in with pnpm test:workrun)",
  () => {
    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), "workrun %n $-"));
      // Setup is deliberately explicit and outside the test: never replace a user's shared budget.
      const root = await properties("workrun.slice");
      if (!(Number(root.MemoryMax) > 0 && Number.isFinite(Number(root.MemoryMax)))) {
        throw new Error("Run explicit workrun setup before the opt-in systemd tests");
      }
    });

    afterEach(async () => {
      for (const target of [scope, other]) await invoke(["--scope", target, "stop", "--all"]);
      for (const child of children) child.kill("SIGTERM");
    });

    afterAll(async () => {
      for (const target of [scope, other]) {
        await capture("systemctl", ["--user", "stop", sliceFor(target)]).catch(() => {});
        const config = join(
          process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
          "systemd",
          "user",
          sliceFor(target),
        );
        await rm(config, { force: true });
        const runtime = join(
          process.env.XDG_RUNTIME_DIR,
          "systemd",
          "user.control",
          `${sliceFor(target)}.d`,
        );
        await rm(runtime, { recursive: true, force: true });
      }
      await capture("systemctl", ["--user", "daemon-reload"]);
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it("preserves cwd, environment, empty arguments, dollars, specifiers and exit status", async () => {
      const args = ["", "$HOME", "%n", "quote'\"", "a\nb", "--scope"];
      const result = await invoke(
        [
          "--scope",
          scope,
          "run",
          "--",
          process.execPath,
          "-e",
          "console.log(JSON.stringify({cwd:process.cwd(),value:process.env.WORKRUN_PROBE,args:process.argv.slice(1)})); process.exit(23)",
          ...args,
        ],
        { env: { ...process.env, WORKRUN_PROBE: "a b\n$c %n" } },
      );
      expect(result).toMatchObject({ code: 23 });
      expect(JSON.parse(result.stdout)).toEqual({ cwd: directory, value: "a b\n$c %n", args });
    });

    it("refuses to run a payload without an explicitly configured shared budget", async () => {
      const marker = join(directory, "must-not-execute");
      const result = await invoke(
        [
          "--scope",
          scope,
          "run",
          "--",
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unprotected')`,
        ],
        { env: { ...process.env, XDG_CONFIG_HOME: join(directory, "unconfigured") } },
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("requires finite");
      expect(await file(marker)).toBe("");
    });

    it("tracks a background process after its launcher returns; isolates duplicate names and stop --all", async () => {
      for (const target of [scope, other]) {
        await successful([
          "--scope",
          target,
          "start",
          "server",
          "--",
          process.execPath,
          "-e",
          hold,
        ]);
      }
      const duplicate = await invoke([
        "--scope",
        scope,
        "start",
        "server",
        "--",
        process.execPath,
        "-e",
        hold,
      ]);
      expect(duplicate.code).not.toBe(0);
      expect((await status("server")).state).toBe("active");
      await successful(["--scope", scope, "stop", "--all"]);
      expect(await jobs(scope)).toEqual([]);
      expect((await status("server", other)).state).toBe("active");
    });

    it("admits one background heavy job across scopes/worktrees, including orphan descendants", async () => {
      const childFile = join(directory, "heavy-child");
      const program = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
      const child=spawn(process.execPath,['-e',${JSON.stringify(hold)}],{detached:true,stdio:'ignore'});
      fs.writeFileSync(${JSON.stringify(childFile)},String(child.pid)); child.unref();`;
      await successful([
        "--scope",
        scope,
        "start",
        "heavy",
        "--heavy",
        "--",
        process.execPath,
        "-e",
        program,
      ]);
      await until(() => file(childFile), Boolean);
      await until(
        () => properties(unitFor(scope, "heavy")),
        (value) => value.MainPID === "0",
      );
      const denied = await invoke(
        ["--scope", other, "run", "--heavy", "--", process.execPath, "-e", "process.exit(0)"],
        { cwd: tmpdir() },
      );
      expect(denied).toMatchObject({ code: 75 });
      expect(denied.stderr).toContain("heavy slot busy");
      await successful(["--scope", scope, "stop", "heavy"]);
      const allowed = await invoke([
        "--scope",
        other,
        "run",
        "--heavy",
        "--",
        process.execPath,
        "-e",
        "process.exit(17)",
      ]);
      expect(allowed).toMatchObject({ code: 17 });
    });

    it("serializes simultaneous heavy admission across scopes", async () => {
      const outcomes = await Promise.all(
        [scope, other].map((target) =>
          invoke([
            "--scope",
            target,
            "start",
            "race",
            "--heavy",
            "--",
            process.execPath,
            "-e",
            hold,
          ]),
        ),
      );
      expect(
        outcomes.map((result) => result.code).toSorted((a, b) => (a ?? -1) - (b ?? -1)),
      ).toEqual([0, 75]);
      expect(
        (await jobs()).filter((job) => job.heavy && [scope, other].includes(job.scope)),
      ).toHaveLength(1);
    });

    it("keeps the foreground heavy slot until completion", async () => {
      const marker = join(directory, "heavy-ready");
      const running = command([
        "--scope",
        scope,
        "run",
        "--name",
        "front-heavy",
        "--heavy",
        "--",
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready'); ${hold}`,
      ]);
      await until(() => file(marker), Boolean);
      expect(
        (await invoke(["--scope", other, "start", "denied", "--heavy", "--", "true"])).code,
      ).toBe(75);
      await successful(["--scope", scope, "stop", "front-heavy"]);
      await running.done;
      expect((await invoke(["--scope", other, "run", "--heavy", "--", "true"])).code).toBe(0);
    });

    it("stops detached descendants that ignore SIGTERM, without touching another scope", async () => {
      const marker = join(directory, "stubborn");
      const stubborn = `process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); ${hold}`;
      await successful([
        "--scope",
        scope,
        "start",
        "tree",
        "--",
        process.execPath,
        "-e",
        `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(stubborn)}],{detached:true,stdio:'ignore'}); ${hold}`,
      ]);
      const pid = Number(await until(() => file(marker), Boolean));
      const cgroup = (await readFile(`/proc/${pid}/cgroup`, "utf8")).trim();
      const parent = await properties(unitFor(scope, "tree"));
      expect(cgroup).toContain(parent.ControlGroup);
      expect(parent.Slice).toBe(sliceFor(scope));
      expect(parent.ControlGroup).toContain("/workrun.slice/");
      await successful(["--scope", scope, "stop", "tree"]);
      await until(
        () => file(`/proc/${pid}/stat`),
        (value) => !value || value.split(" ")[2] === "Z",
      );
    }, 20_000);

    it("interrupts a foreground run and removes its whole cgroup", async () => {
      const marker = join(directory, "foreground");
      const running = command([
        "--scope",
        scope,
        "run",
        "--name",
        "interrupt",
        "--",
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready'); ${hold}`,
      ]);
      await until(() => file(marker), Boolean);
      const group = (await status("interrupt")).ControlGroup;
      running.child.kill("SIGINT");
      expect((await running.done).code).toBe(130);
      await until(
        () => file(join("/sys/fs/cgroup", group, "cgroup.events")),
        (value) => !value || value.includes("populated 0"),
      );
      expect(await jobs(scope)).toEqual([]);
    });

    it("exposes journal output and memory summed over multiple jobs", async () => {
      const marker = join(directory, "allocated");
      await successful([
        "--scope",
        scope,
        "start",
        "one",
        "--",
        process.execPath,
        "-e",
        `global.data=Buffer.alloc(16*1024*1024,1); console.log('workrun-journal-proof'); require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready'); ${hold}`,
      ]);
      await until(() => file(marker), Boolean);
      await successful(["--scope", scope, "start", "two", "--", process.execPath, "-e", hold]);
      const one = await status("one");
      const two = await status("two");
      const slice = await properties(sliceFor(scope));
      expect(Number(slice.MemoryCurrent)).toBeGreaterThan(Number(one.MemoryCurrent));
      expect(Number(slice.MemoryCurrent)).toBeGreaterThan(Number(two.MemoryCurrent));
      const output = await until(
        () => invoke(["--scope", scope, "logs", "one"]),
        (value) => value.stdout.includes("workrun-journal-proof"),
      );
      expect(output.code).toBe(0);
    });

    it("refuses a payload when the kernel no longer enforces its configured ceiling", async () => {
      await successful(["scope", "set", scope, "--memory-max", "128M"]);
      const unit = sliceFor(scope);
      await capture("systemctl", [
        "--user",
        "set-property",
        "--runtime",
        unit,
        "MemoryMax=infinity",
      ]);
      try {
        const marker = join(directory, "must-not-bypass-kernel-limit");
        const result = await invoke([
          "--scope",
          scope,
          "run",
          "--",
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unprotected')`,
        ]);
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("kernel memory.max=max does not match 128M");
        expect(await file(marker)).toBe("");
      } finally {
        await capture("systemctl", ["--user", "set-property", "--runtime", unit, "MemoryMax=128M"]);
        await successful(["scope", "set", scope, "--memory-max", "inherit"]);
      }
    });

    it("applies CPU quota to the whole scope and observes kernel throttling", async () => {
      await successful(["scope", "set", scope, "--cpu-quota", "50%"]);
      const group = (await properties(sliceFor(scope))).ControlGroup;
      const path = join("/sys/fs/cgroup", group);
      const [quota, period] = (await readFile(join(path, "cpu.max"), "utf8"))
        .trim()
        .split(/\s+/)
        .map(Number);
      expect(quota / period).toBe(0.5);
      const throttled = async () =>
        Number(/^nr_throttled (\d+)$/m.exec(await readFile(join(path, "cpu.stat"), "utf8"))?.[1]);
      const before = await throttled();
      await successful([
        "--scope",
        scope,
        "start",
        "cpu",
        "--",
        process.execPath,
        "-e",
        "while(true){}",
      ]);
      await until(throttled, (value) => value > before);
      await successful(["--scope", scope, "stop", "cpu"]);
      await successful(["scope", "set", scope, "--cpu-quota", "inherit"]);
      expect((await properties(sliceFor(scope))).CPUQuotaPerSecUSec).toBe("infinity");
      // systemd may disable the subtree CPU controller once no child needs a local quota.
      const reset = await file(join(path, "cpu.max"));
      expect(reset === "" || reset.startsWith("max ")).toBe(true);
    });

    it("applies and removes a scope budget; a bounded OOM kills only that job", async () => {
      await successful(["--scope", other, "start", "healthy", "--", process.execPath, "-e", hold]);
      await successful(["scope", "set", scope, "--memory-high", "48M", "--memory-max", "64M"]);
      const slice = await properties(sliceFor(scope));
      expect(slice.MemoryMax).toBe(String(64 * 1024 ** 2));
      expect(slice.MemoryHigh).toBe(String(48 * 1024 ** 2));
      // Test the hard boundary, not the intentionally unbounded reclaim delays of memory.high.
      await successful(["scope", "set", scope, "--memory-high", "inherit"]);
      const oom = await invoke([
        "--scope",
        scope,
        "run",
        "--",
        process.execPath,
        "-e",
        "const data=[]; setInterval(()=>data.push(Buffer.alloc(4*1024*1024,1)),5)",
      ]);
      expect(oom.code).not.toBe(0);
      const group = (await properties(sliceFor(scope))).ControlGroup;
      const events = await readFile(join("/sys/fs/cgroup", group, "memory.events"), "utf8");
      expect(Number(/^oom_kill (\d+)$/m.exec(events)?.[1])).toBeGreaterThan(0);
      expect((await status("healthy", other)).state).toBe("active");
      await successful([
        "scope",
        "set",
        scope,
        "--memory-high",
        "inherit",
        "--memory-max",
        "inherit",
      ]);
      const inherited = await properties(sliceFor(scope));
      const root = await properties("workrun.slice");
      expect(inherited.MemoryMax).toBe("infinity");
      expect(inherited.EffectiveMemoryMax).toBe(root.MemoryMax);
      expect((await invoke(["--scope", other, "run", "--", "true"])).code).toBe(0);
    }, 30_000);
  },
);
