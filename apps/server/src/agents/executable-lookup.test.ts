import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { isExecutable } from "./executable-lookup.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "corral-lookup-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("a command is found when an executable file of that name is in a PATH directory", () => {
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "tool"), "#!/bin/sh\n");
  chmodSync(join(bin, "tool"), 0o755);
  writeFileSync(join(bin, "plain"), "data");
  mkdirSync(join(bin, "directory"));

  const path = `${join(root, "empty")}:${bin}`;
  expect(isExecutable("tool", path)).toBe(true);
  expect(isExecutable("plain", path)).toBe(false);
  expect(isExecutable("directory", path)).toBe(false);
  expect(isExecutable("missing", path)).toBe(false);
  expect(isExecutable("tool", undefined)).toBe(false);
  expect(isExecutable(join(bin, "tool"), "")).toBe(true);
});
