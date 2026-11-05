import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEAVY_SLOTS,
  identifier,
  cpuPercent,
  heavySlots,
  jobFromUnit,
  limits,
  memoryBytes,
  parse,
  sliceFor,
  unitFor,
} from "./model.mjs";

const group = ["--group", "my-project"];

describe("workrun command contract", () => {
  it("keeps command arguments literal after the separator", () => {
    const command = ["node", "-e", "console.log('$HOME %n')", "", "--scope", "unrelated"];
    expect(parse([...group, "run", "--heavy", "--", ...command]).command).toEqual(command);
  });

  it("requires a group and an unambiguous target before destructive operations", () => {
    for (const argv of [
      ["stop", "--all"],
      [...group, "stop"],
      [...group, "stop", "web", "--all"],
    ]) {
      expect(() => parse(argv)).toThrow(/requires|does not accept/);
    }
    expect(parse([...group, "stop", "--all"]).values.all).toBe(true);
  });

  it("accepts named and unnamed runs, positional background jobs and heavy no-wait", () => {
    expect(parse([...group, "run", "--", "true"]).values.name).toBeUndefined();
    expect(parse([...group, "run", "--name", "issue135-check", "--", "true"]).values.name).toBe(
      "issue135-check",
    );
    const request = parse([...group, "start", "dev", "--heavy", "--no-wait", "--", "true"]);
    expect(request.positionals).toEqual(["dev"]);
    expect(request.values).toMatchObject({ group: "my-project", heavy: true, "no-wait": true });
  });

  it("rejects old aliases, ignored flags and an implicit unprotected launch", () => {
    for (const argv of [
      [],
      ["run", "--", "true"],
      ["--scope", "a", "run", "--", "true"],
      ["scope", "set", "a", "--memory-max", "1G"],
      [...group, "run"],
      [...group, "start", "--", "true"],
      [...group, "start", "web", "--name", "other", "--", "true"],
      [...group, "run", "check", "--", "true"],
      [...group, "run", "--no-wait", "--", "true"],
      ["setup", "--memory-max", "1G"],
      ["setup", "--memory-high", "1G", "--memory-max", "2G", "--heavy-slots", "2"],
      ["group", "set", "a"],
      [...group, "list", "--heavy"],
      ["list", "--", "true"],
    ])
      expect(() => parse(argv)).toThrow(
        /expected|requires|not valid|accepts|does not accept|Unknown option/,
      );
  });
});

describe("workrun names and budgets", () => {
  it("defaults to one heavy slot and validates per-group slot counts", () => {
    expect(DEFAULT_HEAVY_SLOTS).toBe(1);
    expect(heavySlots("2")).toBe(2);
    expect(parse(["group", "set", "build", "--heavy-slots", "3"]).values["heavy-slots"]).toBe("3");
    for (const count of ["0", "-1", "1.5", "2G", "Infinity", "9007199254740992", "2\nfoo"]) {
      expect(() => heavySlots(count)).toThrow(/positive integer/);
      expect(() => parse(["group", "set", "build", "--heavy-slots", count])).toThrow(
        /heavy-slots|argument/,
      );
    }
  });

  it("accepts shared/group CPU ceilings and explicit inheritance", () => {
    expect(cpuPercent("600%")).toBe(600);
    expect(cpuPercent("inherit")).toBe(Infinity);
    expect(parse(["group", "set", "build", "--cpu-quota", "200%"]).values["cpu-quota"]).toBe(
      "200%",
    );
    for (const quota of ["0%", "-1%", "600", "1.5%", "100%\nMemoryMax=infinity"]) {
      expect(() => cpuPercent(quota)).toThrow(/positive integer percentage/);
    }
  });

  it("maps group/job names injectively without accidental slice ancestors", () => {
    expect(sliceFor("my-project")).toBe("workrun-my\\x2dproject.slice");
    const names = ["a", "a-b", "a_b", "1", "a--b"];
    const units = names.flatMap((target) => names.map((name) => unitFor(target, name)));
    expect(new Set(units).size).toBe(units.length);
    for (const target of names)
      for (const name of names) {
        expect(jobFromUnit(unitFor(target, name))).toEqual({ group: target, name });
      }
    expect(jobFromUnit("other-a-b.service")).toBeUndefined();
    expect(jobFromUnit("workrun-a-b-c.service")).toBeUndefined();
    expect(jobFromUnit("workrun-a-\\x41.service")).toBeUndefined();
  });

  it("refuses names that could become paths, options or unit syntax", () => {
    for (const name of ["", "../web", "--all", "a/b", "A", "a.service", "x".repeat(49), "a\nb"]) {
      expect(() => identifier(name)).toThrow(/must be 1–48/);
    }
  });

  it("requires a finite shared budget and supports inherited group limits", () => {
    expect(memoryBytes("12G")).toBe(12 * 1024 ** 3);
    expect(limits("6G", "8G", true)).toEqual({ high: "6G", max: "8G" });
    expect(limits("inherit", "inherit")).toEqual({ high: "infinity", max: "infinity" });
    expect(limits("inherit", "8G")).toEqual({ high: "infinity", max: "8G" });
    expect(() => limits("inherit", "12G", true)).toThrow(/requires finite/);
    expect(() => limits("10G", "8G")).toThrow(/must not exceed/);
    for (const value of [
      "0",
      "-1G",
      "1.5G",
      "12GB",
      "10G\nMemoryMax=infinity",
      "999999999999999T",
    ]) {
      expect(() => memoryBytes(value)).toThrow(/positive integers|too large/);
    }
  });
});
