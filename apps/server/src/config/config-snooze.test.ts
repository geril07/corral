import { defaultClientConfig } from "@corral/protocol/config";
import { expect, test } from "vite-plus/test";
import { parseConfigFile } from "./config-file.ts";

const DATA_DIR = "/data";
const parse = (text: string) => parseConfigFile(text, DATA_DIR);

test("no [snooze] means the built-in menu", () => {
  const { config, problems } = parse("");

  expect(problems).toEqual([]);
  expect(config.snooze.presets).toEqual(defaultClientConfig(DATA_DIR).snooze.presets);
});

test("presets parse as written, in the order the file lists them", () => {
  const { config, problems } = parse(`
[snooze]
presets = ["90m", "2h", "1d", "today 18:00", "tomorrow 09:00", "monday 09:00"]
`);

  expect(problems).toEqual([]);
  expect(config.snooze.presets).toEqual({
    value: [
      { kind: "after", minutes: 90 },
      { kind: "after", minutes: 120 },
      { kind: "after", minutes: 1440 },
      { kind: "at", day: "today", time: "18:00" },
      { kind: "at", day: "tomorrow", time: "09:00" },
      { kind: "at", day: "monday", time: "09:00" },
    ],
    source: "global",
  });
});

test("a bad entry drops alone, is named by index, and leaves the rest of the menu", () => {
  const { config, problems } = parse(`
[snooze]
presets = ["2h", "soon", 3, "31d", "someday 09:00", "24:00", "tuesday 09:00"]
`);

  expect(config.snooze.presets.value).toEqual([
    { kind: "after", minutes: 120 },
    { kind: "at", day: "tuesday", time: "09:00" },
  ]);
  expect(problems.map((problem) => problem.path)).toEqual([
    "snooze.presets.1",
    "snooze.presets.2",
    "snooze.presets.3",
    "snooze.presets.4",
    "snooze.presets.5",
  ]);
});

test("the menu keeps at most eight presets and says so once", () => {
  const presets = Array.from({ length: 9 }, (_, index) => `"${index + 1}h"`).join(", ");
  const { config, problems } = parse(`[snooze]\npresets = [${presets}]\n`);

  expect(config.snooze.presets.value).toHaveLength(8);
  expect(problems).toEqual([
    expect.objectContaining({ severity: "error", path: "snooze.presets" }),
  ]);
});

test("[snooze] has no per-project layer and refuses an unknown key", () => {
  const { config, problems } = parse(`
[snooze]
presets = []
wake-at = "9am"
`);

  expect(config.snooze.presets).toEqual({ value: [], source: "global" });
  expect(problems).toEqual([expect.objectContaining({ path: "snooze.wake-at" })]);
});
