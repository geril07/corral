/* eslint-disable no-await-in-loop -- Lifecycle probes and teardown observe each state before advancing. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { capture, existingLimits, jobs, properties } from "./systemd.mjs";
import { sliceFor, unitFor } from "./model.mjs";

const cli = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const enabled = process.env.WORKRUN_SYSTEMD_TEST === "1";
const group = `test-${randomUUID().slice(0, 8)}`;
const other = `${group}-other`;
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
  return {
    child,
    done,
    get stderr() {
      return stderr;
    },
  };
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

async function status(name: string, target = group) {
  const result = await invoke(["--group", target, "status", name, "--json"]);
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
      for (const child of children) child.kill("SIGTERM");
      await until(
        () => children.size,
        (value) => value === 0,
      );
      for (const target of [group, other]) {
        await successful(["--group", target, "stop", "--all"]);
        const remaining = await jobs(target);
        if (remaining.length)
          throw new Error(`test cleanup left jobs: ${JSON.stringify(remaining)}`);
        await successful([
          "group",
          "set",
          target,
          "--heavy-slots",
          "1",
          "--memory-high",
          "inherit",
          "--memory-max",
          "inherit",
          "--cpu-quota",
          "inherit",
        ]);
      }
    });

    afterAll(async () => {
      for (const target of [group, other]) {
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
      const args = ["", "$HOME", "%n", "quote'\"", "a\nb", "--group"];
      const result = await invoke(
        [
          "--group",
          group,
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
          "--group",
          group,
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
      for (const target of [group, other]) {
        await successful([
          "--group",
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
        "--group",
        group,
        "start",
        "server",
        "--",
        process.execPath,
        "-e",
        hold,
      ]);
      expect(duplicate.code).not.toBe(0);
      expect((await status("server")).state).toBe("active");
      await successful(["--group", group, "stop", "--all"]);
      expect(await jobs(group)).toEqual([]);
      expect((await status("server", other)).state).toBe("active");
    });

    it("shares capacity across worktrees, but not across project groups, including orphan descendants", async () => {
      const childFile = join(directory, "heavy-child");
      const program = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
      const child=spawn(process.execPath,['-e',${JSON.stringify(hold)}],{detached:true,stdio:'ignore'});
      fs.writeFileSync(${JSON.stringify(childFile)},String(child.pid)); child.unref();`;
      await successful([
        "--group",
        group,
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
        () => properties(unitFor(group, "heavy")),
        (value) => value.MainPID === "0",
      );
      const denied = await invoke(["--group", group, "run", "--heavy", "--no-wait", "--", "true"], {
        cwd: tmpdir(),
      });
      expect(denied).toMatchObject({ code: 75 });
      expect(denied.stderr).toContain("heavy slots busy");
      await successful([
        "--group",
        other,
        "start",
        "heavy",
        "--heavy",
        "--",
        process.execPath,
        "-e",
        hold,
      ]);
      await successful(["--group", group, "run", "--", "true"]);
      await successful(["--group", group, "stop", "heavy"]);
      const allowed = await invoke([
        "--group",
        group,
        "run",
        "--heavy",
        "--",
        process.execPath,
        "-e",
        "process.exit(17)",
      ]);
      expect(allowed.code).toBe(17);
      expect((await status("heavy", other)).state).toBe("active");
    });

    it("atomically admits exactly N simultaneous heavy jobs within a group", async () => {
      await successful(["group", "set", group, "--heavy-slots", "2"]);
      const outcomes = await Promise.all(
        ["one", "two", "three", "four"].map((name) =>
          invoke([
            "--group",
            group,
            "start",
            name,
            "--heavy",
            "--no-wait",
            "--",
            process.execPath,
            "-e",
            hold,
          ]),
        ),
      );
      expect(
        outcomes.map((result) => result.code).toSorted((a, b) => (a ?? -1) - (b ?? -1)),
      ).toEqual([0, 0, 75, 75]);
      expect((await jobs(group)).filter((job) => job.heavy)).toHaveLength(2);
    });

    it("waits without launching a foreground payload, then returns its result", async () => {
      await successful([
        "--group",
        group,
        "start",
        "owner",
        "--heavy",
        "--",
        process.execPath,
        "-e",
        hold,
      ]);
      const marker = join(directory, "waiter-ran");
      const waiting = command([
        "--group",
        group,
        "run",
        "--name",
        "waiter",
        "--heavy",
        "--",
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran'); process.exit(23)`,
      ]);
      await until(
        () => waiting.stderr,
        (value) => value.includes("waiting for a heavy slot"),
      );
      expect(await file(marker)).toBe("");
      expect((await jobs(group)).map((job) => job.name)).toEqual(["owner"]);
      await successful(["--group", group, "stop", "owner"]);
      expect((await waiting.done).code).toBe(23);
      expect(await file(marker)).toBe("ran");
    });

    it("makes start wait for admission, then returns while its heavy job stays alive", async () => {
      await successful([
        "--group",
        group,
        "start",
        "owner",
        "--heavy",
        "--",
        process.execPath,
        "-e",
        hold,
      ]);
      const waiting = command([
        "--group",
        group,
        "start",
        "next",
        "--heavy",
        "--",
        process.execPath,
        "-e",
        hold,
      ]);
      let completed = false;
      void waiting.done.then(() => {
        completed = true;
      });
      await until(
        () => waiting.stderr,
        (value) => value.includes("waiting for a heavy slot"),
      );
      expect(completed).toBe(false);
      expect(await status("next")).toBeUndefined();
      await successful(["--group", group, "stop", "owner"]);
      expect((await waiting.done).code).toBe(0);
      expect((await status("next")).state).toBe("active");
      expect(
        (await invoke(["--group", group, "run", "--heavy", "--no-wait", "--", "true"])).code,
      ).toBe(75);
    });

    it.each([
      ["SIGINT", 130],
      ["SIGTERM", 143],
      ["SIGHUP", 129],
    ] as const)(
      "cancels a same-named waiter with %s without launching or stopping the incumbent",
      async (signal, code) => {
        await successful([
          "--group",
          group,
          "start",
          "owner",
          "--heavy",
          "--",
          process.execPath,
          "-e",
          hold,
        ]);
        const original = await status("owner");
        const marker = join(directory, `cancelled-${signal}`);
        const waiting = command([
          "--group",
          group,
          "run",
          "--name",
          "owner",
          "--heavy",
          "--",
          process.execPath,
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`,
        ]);
        await until(
          () => waiting.stderr,
          (value) => value.includes("waiting for a heavy slot"),
        );
        waiting.child.kill(signal);
        expect((await waiting.done).code).toBe(code);
        expect(await file(marker)).toBe("");
        expect(await status("owner")).toMatchObject({ MainPID: original.MainPID, state: "active" });
        await successful(["--group", group, "stop", "owner"]);
        await successful(["--group", group, "run", "--heavy", "--", "true"]);
        expect(await file(marker)).toBe("");
      },
    );

    it("lets configuration changes unblock waiters without pre-empting existing jobs", async () => {
      await successful([
        "--group",
        group,
        "start",
        "one",
        "--heavy",
        "--",
        process.execPath,
        "-e",
        hold,
      ]);
      const waiting = command([
        "--group",
        group,
        "start",
        "two",
        "--heavy",
        "--",
        process.execPath,
        "-e",
        hold,
      ]);
      await until(
        () => waiting.stderr,
        (value) => value.includes("waiting for a heavy slot"),
      );
      await successful(["group", "set", group, "--heavy-slots", "2"]);
      expect((await waiting.done).code).toBe(0);
      await successful(["group", "set", group, "--heavy-slots", "1"]);
      expect((await jobs(group)).filter((job) => job.heavy)).toHaveLength(2);
      await successful(["--group", group, "stop", "one"]);
      expect(
        (await invoke(["--group", group, "run", "--heavy", "--no-wait", "--", "true"])).code,
      ).toBe(75);
      await successful(["--group", group, "stop", "two"]);
      await successful(["--group", group, "run", "--heavy", "--", "true"]);
    });

    it("counts foreground heavy jobs without reducing N slots to one and preserves a payload exit 75", async () => {
      await successful(["group", "set", group, "--heavy-slots", "2"]);
      const marker = join(directory, "front-heavy-ready");
      const running = command([
        "--group",
        group,
        "run",
        "--name",
        "front",
        "--heavy",
        "--",
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready'); ${hold}`,
      ]);
      await until(() => file(marker), Boolean);
      await successful([
        "--group",
        group,
        "start",
        "back",
        "--heavy",
        "--",
        process.execPath,
        "-e",
        hold,
      ]);
      expect(
        (await invoke(["--group", group, "run", "--heavy", "--no-wait", "--", "true"])).code,
      ).toBe(75);
      await successful(["--group", group, "stop", "front"]);
      await running.done;
      const payload = await invoke([
        "--group",
        group,
        "run",
        "--heavy",
        "--no-wait",
        "--",
        process.execPath,
        "-e",
        "process.exit(75)",
      ]);
      expect(payload.code).toBe(75);
      expect(payload.stderr).not.toContain("heavy slots busy");
    });

    it("holds a slot while a job is deactivating with a stubborn descendant", async () => {
      const marker = join(directory, "heavy-stubborn");
      const stubborn = `process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready'); ${hold}`;
      await successful([
        "--group",
        group,
        "start",
        "heavy-tree",
        "--heavy",
        "--",
        process.execPath,
        "-e",
        `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(stubborn)}],{detached:true,stdio:'ignore'}); ${hold}`,
      ]);
      await until(() => file(marker), Boolean);
      const stopping = command(["--group", group, "stop", "heavy-tree"]);
      await until(
        () => properties(unitFor(group, "heavy-tree")),
        (value) => value.ActiveState === "deactivating",
      );
      expect(
        (await invoke(["--group", group, "run", "--heavy", "--no-wait", "--", "true"])).code,
      ).toBe(75);
      expect((await stopping.done).code).toBe(0);
      await successful(["--group", group, "run", "--heavy", "--", "true"]);
    }, 20_000);

    it("persists heavy settings and preserves omitted CPU and memory budgets", async () => {
      await successful([
        "group",
        "set",
        group,
        "--heavy-slots",
        "2",
        "--memory-max",
        "256M",
        "--cpu-quota",
        "100%",
      ]);
      await successful(["group", "set", group, "--memory-high", "128M"]);
      const settings = await existingLimits(sliceFor(group));
      expect(settings).toMatchObject({ heavySlots: 2, high: "128M", max: "256M", cpu: "100%" });
      const output = await successful(["group", "set", group, "--heavy-slots", "3"]);
      expect(output.stdout).toContain("heavy-slots=3");
      expect(await existingLimits(sliceFor(group))).toMatchObject({
        heavySlots: 3,
        high: "128M",
        max: "256M",
        cpu: "100%",
      });
    });

    it("stops detached descendants that ignore SIGTERM, without touching another group", async () => {
      const marker = join(directory, "stubborn");
      const stubborn = `process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); ${hold}`;
      await successful([
        "--group",
        group,
        "start",
        "tree",
        "--",
        process.execPath,
        "-e",
        `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(stubborn)}],{detached:true,stdio:'ignore'}); ${hold}`,
      ]);
      const pid = Number(await until(() => file(marker), Boolean));
      const cgroup = (await readFile(`/proc/${pid}/cgroup`, "utf8")).trim();
      const parent = await properties(unitFor(group, "tree"));
      expect(cgroup).toContain(parent.ControlGroup);
      expect(parent.Slice).toBe(sliceFor(group));
      expect(parent.ControlGroup).toContain("/workrun.slice/");
      await successful(["--group", group, "stop", "tree"]);
      await until(
        () => file(`/proc/${pid}/stat`),
        (value) => !value || value.split(" ")[2] === "Z",
      );
    }, 20_000);

    it("interrupts a foreground run and removes its whole cgroup", async () => {
      const marker = join(directory, "foreground");
      const running = command([
        "--group",
        group,
        "run",
        "--name",
        "interrupt",
        "--",
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready'); ${hold}`,
      ]);
      await until(() => file(marker), Boolean);
      const cgroup = (await status("interrupt")).ControlGroup;
      running.child.kill("SIGINT");
      expect((await running.done).code).toBe(130);
      await until(
        () => file(join("/sys/fs/cgroup", cgroup, "cgroup.events")),
        (value) => !value || value.includes("populated 0"),
      );
      expect(await jobs(group)).toEqual([]);
    });

    it("exposes journal output and memory summed over multiple jobs", async () => {
      const marker = join(directory, "allocated");
      await successful([
        "--group",
        group,
        "start",
        "one",
        "--",
        process.execPath,
        "-e",
        `global.data=Buffer.alloc(16*1024*1024,1); console.log('workrun-journal-proof'); require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready'); ${hold}`,
      ]);
      await until(() => file(marker), Boolean);
      await successful(["--group", group, "start", "two", "--", process.execPath, "-e", hold]);
      const one = await status("one");
      const two = await status("two");
      const slice = await properties(sliceFor(group));
      expect(Number(slice.MemoryCurrent)).toBeGreaterThan(Number(one.MemoryCurrent));
      expect(Number(slice.MemoryCurrent)).toBeGreaterThan(Number(two.MemoryCurrent));
      const output = await until(
        () => invoke(["--group", group, "logs", "one"]),
        (value) => value.stdout.includes("workrun-journal-proof"),
      );
      expect(output.code).toBe(0);
    });

    it("refuses a payload when the kernel no longer enforces its configured ceiling", async () => {
      await successful(["group", "set", group, "--memory-max", "128M"]);
      const unit = sliceFor(group);
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
          "--group",
          group,
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
        await successful(["group", "set", group, "--memory-max", "inherit"]);
      }
    });

    it("applies CPU quota to the whole group and observes kernel throttling", async () => {
      await successful(["group", "set", group, "--cpu-quota", "50%"]);
      const cgroup = (await properties(sliceFor(group))).ControlGroup;
      const path = join("/sys/fs/cgroup", cgroup);
      const [quota, period] = (await readFile(join(path, "cpu.max"), "utf8"))
        .trim()
        .split(/\s+/)
        .map(Number);
      expect(quota / period).toBe(0.5);
      const throttled = async () =>
        Number(/^nr_throttled (\d+)$/m.exec(await readFile(join(path, "cpu.stat"), "utf8"))?.[1]);
      const before = await throttled();
      await successful([
        "--group",
        group,
        "start",
        "cpu",
        "--",
        process.execPath,
        "-e",
        "while(true){}",
      ]);
      await until(throttled, (value) => value > before);
      await successful(["--group", group, "stop", "cpu"]);
      await successful(["group", "set", group, "--cpu-quota", "inherit"]);
      expect((await properties(sliceFor(group))).CPUQuotaPerSecUSec).toBe("infinity");
      // systemd may disable the subtree CPU controller once no child needs a local quota.
      const reset = await file(join(path, "cpu.max"));
      expect(reset === "" || reset.startsWith("max ")).toBe(true);
    });

    it("applies and removes a group budget; a bounded OOM kills only that job", async () => {
      await successful(["--group", other, "start", "healthy", "--", process.execPath, "-e", hold]);
      await successful(["group", "set", group, "--memory-high", "48M", "--memory-max", "64M"]);
      const slice = await properties(sliceFor(group));
      expect(slice.MemoryMax).toBe(String(64 * 1024 ** 2));
      expect(slice.MemoryHigh).toBe(String(48 * 1024 ** 2));
      // Test the hard boundary, not the intentionally unbounded reclaim delays of memory.high.
      await successful(["group", "set", group, "--memory-high", "inherit"]);
      const oom = await invoke([
        "--group",
        group,
        "run",
        "--",
        process.execPath,
        "-e",
        "const data=[]; setInterval(()=>data.push(Buffer.alloc(4*1024*1024,1)),5)",
      ]);
      expect(oom.code).not.toBe(0);
      const cgroup = (await properties(sliceFor(group))).ControlGroup;
      const events = await readFile(join("/sys/fs/cgroup", cgroup, "memory.events"), "utf8");
      expect(Number(/^oom_kill (\d+)$/m.exec(events)?.[1])).toBeGreaterThan(0);
      expect((await status("healthy", other)).state).toBe("active");
      await successful([
        "group",
        "set",
        group,
        "--memory-high",
        "inherit",
        "--memory-max",
        "inherit",
      ]);
      const inherited = await properties(sliceFor(group));
      const root = await properties("workrun.slice");
      expect(inherited.MemoryMax).toBe("infinity");
      expect(inherited.EffectiveMemoryMax).toBe(root.MemoryMax);
      expect((await invoke(["--group", other, "run", "--", "true"])).code).toBe(0);
    }, 30_000);
  },
);
