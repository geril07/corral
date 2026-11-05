import { describe, expect, it } from "vitest";
import {
  identifier,
  cpuPercent,
  jobFromUnit,
  limits,
  memoryBytes,
  parse,
  sliceFor,
  unitFor,
} from "./model.mjs";

describe("workrun command contract", () => {
  it("keeps command arguments literal after the separator", () => {
    const command = ["node", "-e", "console.log('$HOME %n')", "", "--scope", "unrelated"];
    expect(parse(["--scope", "my-project", "run", "--heavy", "--", ...command]).command).toEqual(
      command,
    );
  });

  it("requires scope and an unambiguous target before destructive operations", () => {
    for (const argv of [
      ["stop", "--all"],
      ["--scope", "a", "stop"],
      ["--scope", "a", "stop", "web", "--all"],
    ]) {
      expect(() => parse(argv)).toThrow(/requires|does not accept/);
    }
    expect(parse(["--scope", "a", "stop", "--all"]).values.all).toBe(true);
  });

  it("rejects ignored flags, malformed invocations and an implicit unprotected launch", () => {
    for (const argv of [
      [],
      ["run", "--", "true"],
      ["--scope", "a", "run"],
      ["--scope", "a", "start", "--", "true"],
      ["--scope", "a", "start", "web", "--name", "other", "--", "true"],
      ["setup", "--memory-max", "1G"],
      ["scope", "set", "a"],
      ["--scope", "a", "list", "--heavy"],
      ["list", "--", "true"],
    ])
      expect(() => parse(argv)).toThrow(/expected|requires|not valid|does not accept/);
  });
});

describe("workrun names and budgets", () => {
  it("accepts shared/scope CPU ceilings and explicit inheritance", () => {
    expect(cpuPercent("600%")).toBe(600);
    expect(cpuPercent("inherit")).toBe(Infinity);
    expect(parse(["scope", "set", "build", "--cpu-quota", "200%"]).values["cpu-quota"]).toBe(
      "200%",
    );
    for (const quota of ["0%", "-1%", "600", "1.5%", "100%\nMemoryMax=infinity"]) {
      expect(() => cpuPercent(quota)).toThrow(/positive integer percentage/);
    }
  });
  it("maps names injectively without introducing accidental slice ancestors", () => {
    expect(sliceFor("my-project")).toBe("workrun-my\\x2dproject.slice");
    const names = ["a", "a-b", "a_b", "1", "a--b"];
    const units = names.flatMap((scope) => names.map((name) => unitFor(scope, name)));
    expect(new Set(units).size).toBe(units.length);
    for (const scope of names)
      for (const name of names) {
        expect(jobFromUnit(unitFor(scope, name))).toEqual({ scope, name });
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

  it("requires a finite shared budget and supports inherited scope limits", () => {
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
