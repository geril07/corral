import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MANAGED, ROOT_SLICE, sliceFor } from "./model.mjs";
import { existingLimits } from "./systemd.mjs";

let directory: string;
let units: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "workrun-config-"));
  vi.stubEnv("XDG_CONFIG_HOME", directory);
  units = join(directory, "systemd", "user");
  await mkdir(units, { recursive: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe("workrun persisted group settings", () => {
  it("uses inherited ceilings and one slot for a group with no file", async () => {
    expect(await existingLimits(sliceFor("fresh"))).toEqual({
      high: "infinity",
      max: "infinity",
      cpu: "",
      heavySlots: 1,
    });
  });

  it("reads old scope budget files without resetting budgets or requiring migration", async () => {
    const content = `${MANAGED}[Slice]\nMemoryHigh=4G\nMemoryMax=6G\nCPUQuota=200%\n`;
    const path = join(units, sliceFor("corral"));
    await writeFile(path, content);
    expect(await existingLimits(sliceFor("corral"))).toEqual({
      high: "4G",
      max: "6G",
      cpu: "200%",
      heavySlots: 1,
    });
    expect(await readFile(path, "utf8")).toBe(content);
  });

  it("reads the shared budget and a group's explicit slot count", async () => {
    await writeFile(
      join(units, ROOT_SLICE),
      `${MANAGED}[Slice]\nMemoryHigh=6G\nMemoryMax=8G\nCPUQuota=400%\n`,
    );
    await writeFile(
      join(units, sliceFor("corral")),
      `${MANAGED}# HeavySlots=3\n[Slice]\nMemoryMax=4G\n`,
    );
    expect(await existingLimits(ROOT_SLICE)).toMatchObject({ high: "6G", max: "8G", cpu: "400%" });
    expect(await existingLimits(sliceFor("corral"))).toMatchObject({ heavySlots: 3, max: "4G" });
  });

  it("refuses unmanaged files and corrupted admission settings", async () => {
    const path = join(units, sliceFor("corral"));
    await writeFile(path, "[Slice]\nMemoryMax=4G\n");
    await expect(existingLimits(sliceFor("corral"))).rejects.toThrow(/unmanaged/);
    await writeFile(path, `${MANAGED}# HeavySlots=0\n[Slice]\n`);
    await expect(existingLimits(sliceFor("corral"))).rejects.toThrow(/positive integer/);
  });
});
