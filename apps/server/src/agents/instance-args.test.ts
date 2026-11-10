import { expect, test } from "vite-plus/test";
import { instanceArgsProblem } from "./instance-args.ts";

test("Pi accepts only known metadata options with explicit values", () => {
  expect(instanceArgsProblem("pi", ["--no-skills", "--extension", "/tmp/ext.ts"])).toBeUndefined();
  for (const args of [
    ["--mode", "rpc"],
    ["--mode=rpc"],
    ["--session=/tmp/s"],
    ["--session-id", "x"],
    ["--resume"],
    ["-r"],
    ["--continue"],
    ["-c"],
    ["--print"],
    ["-p"],
    ["--model", "other"],
    ["--provider=other"],
    ["--models", "other"],
    ["--unknown", "prompt"],
    ["--"],
    ["prompt"],
    ["--extension"],
    ["--extension", "--resume"],
    ["--no-session"],
    ["--api-key", "secret"],
  ])
    expect(instanceArgsProblem("pi", args)).toBeDefined();
  expect(instanceArgsProblem("opencode", ["--no-skills"])).toBeDefined();
  expect(instanceArgsProblem("opencode", [])).toBeUndefined();
});
