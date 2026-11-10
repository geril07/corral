import {
  ActionId,
  ClientConfig,
  ConfigProblem,
  DEFAULT_BINDINGS,
  DEFAULT_DIRECT_BINDINGS,
  DEFAULT_PREFIX,
} from "@corral/protocol/config";
import { formatChord, parseChord } from "@corral/protocol/keymap";
import * as fc from "fast-check";
import { expect, test } from "vite-plus/test";
import { defaultClientConfig } from "@corral/protocol/config";
import { parseConfigFile } from "./config-file.ts";

const DATA_DIR = "/data";
const defaults = defaultClientConfig(DATA_DIR);
const parseText = (text: string) => parseConfigFile(text, DATA_DIR);

test("an empty file is the defaults, without problems", () => {
  expect(parseText("")).toEqual({ config: defaults, profiles: [], problems: [] });
});

test("a file with no [keys] section is the defaults too", () => {
  expect(parseText("# nothing here yet\n")).toEqual({
    config: defaults,
    profiles: [],
    problems: [],
  });
});

test("a prefix entry applies over the default", () => {
  const { config, problems } = parseText('[keys]\nprefix = "ctrl+a"\n');

  expect(problems).toEqual([]);
  expect(config).toEqual({
    ...defaults,
    keys: { prefix: "ctrl+a", bindings: DEFAULT_BINDINGS, direct: DEFAULT_DIRECT_BINDINGS },
  });
});

test("a binding applies over the default", () => {
  const { config, problems } = parseText('[keys.bindings]\nnew-agent = "a"\n');

  expect(problems).toEqual([]);
  expect(config.keys.bindings).toEqual({ ...DEFAULT_BINDINGS, "new-agent": "a" });
});

test("an empty string unbinds the action", () => {
  const { config, problems } = parseText('[keys.bindings]\nboard = ""\n');

  expect(problems).toEqual([]);
  expect(config.keys.bindings).toEqual({ ...DEFAULT_BINDINGS, board: null });
});

test("every action can be rebound; the untouched ones keep their default", () => {
  const { config, problems } = parseText(
    '[keys.bindings]\nnew-terminal = "shift+n"\ncommand-palette = "y"\n',
  );

  expect(problems).toEqual([]);
  expect(config.keys.bindings).toEqual({
    ...DEFAULT_BINDINGS,
    "new-terminal": "shift+n",
    "command-palette": "y",
  });
});

test("a syntax error drops the whole file but reports where it broke", () => {
  const { config, problems } = parseText('[keys]\nprefix = \n"alt+b"\n');

  expect(config).toEqual(defaults);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toMatchObject({ severity: "error", path: "" });
  expect(problems[0]?.message).toMatch(/^invalid TOML at line 2, column \d+: /);
});

test("a direct command applies over its default and an empty string unbinds it", () => {
  const { config, problems } = parseText(
    '[keys.direct]\nnew-task = "ctrl+shift+j"\nnew-task-no-project = ""\n',
  );

  expect(problems).toEqual([]);
  expect(config.keys.direct).toEqual({
    ...DEFAULT_DIRECT_BINDINGS,
    "new-task": "ctrl+shift+j",
    "new-task-no-project": null,
  });
});

test("a direct command without a modifier is refused, so typing is never captured", () => {
  const { config, problems } = parseText('[keys.direct]\nnew-task = "n"\n');

  expect(config.keys.direct["new-task"]).toBe(DEFAULT_DIRECT_BINDINGS["new-task"]);
  expect(problems).toEqual([
    {
      severity: "error",
      path: "keys.direct.new-task",
      message: '"n" needs mod, ctrl, meta or alt so typing is not captured',
    },
  ]);
});

test("two direct commands on one chord both fall back to their defaults", () => {
  const { config, problems } = parseText(
    '[keys.direct]\nnew-task = "alt+n"\nnew-task-no-project = "alt+n"\n',
  );

  expect(config.keys.direct).toEqual(DEFAULT_DIRECT_BINDINGS);
  expect(problems.map((problem) => problem.path).toSorted()).toEqual([
    "keys.direct.new-task",
    "keys.direct.new-task-no-project",
  ]);
  for (const problem of problems)
    expect(problem.message).toContain('the chord "alt+n" is also used by');
});

test("a direct command on the prefix chord is dropped", () => {
  const { config, problems } = parseText('[keys.direct]\nnew-task = "alt+a"\n');

  expect(config.keys.direct["new-task"]).toBe(DEFAULT_DIRECT_BINDINGS["new-task"]);
  expect(problems).toEqual([
    {
      severity: "error",
      path: "keys.direct.new-task",
      message: 'the chord "alt+a" is also used by the prefix',
    },
  ]);
});

test("a prefix on a direct command's mod chord falls back to the default prefix", () => {
  // mod+n is Ctrl+n where Ctrl is the mod key, so the default direct command owns that press.
  const { config, problems } = parseText('[keys]\nprefix = "ctrl+n"\n');

  expect(config.keys.prefix).toBe(DEFAULT_PREFIX);
  expect(problems).toEqual([
    {
      severity: "warning",
      path: "keys.prefix",
      message: 'the browser keeps "ctrl+n" for itself, so the page may never see it',
    },
    {
      severity: "error",
      path: "keys.prefix",
      message: 'the chord "ctrl+n" is also used by a direct command',
    },
  ]);
});

test("an explicit direct command the browser keeps is a warning, not an error", () => {
  const { config, problems } = parseText('[keys.direct]\nnew-task = "ctrl+n"\n');

  expect(config.keys.direct["new-task"]).toBe("ctrl+n");
  expect(problems).toEqual([
    {
      severity: "warning",
      path: "keys.direct.new-task",
      message: 'the browser keeps "ctrl+n" for itself, so the page may never see it',
    },
  ]);
});

const rejected: [file: string, path: string, message: string][] = [
  ["other = 1\n", "other", "unknown section"],
  ["[other]\nx = 1\n", "other", "unknown section"],
  ["[keys]\nother = 1\n", "keys.other", "unknown key"],
  ["keys = 5\n", "keys", "expected a table, got a number"],
  ["[keys]\nbindings = 5\n", "keys.bindings", "expected a table, got a number"],
  ["[keys]\ndirect = 5\n", "keys.direct", "expected a table, got a number"],
  [
    '[keys.direct]\nlaunch-missiles = "ctrl+m"\n',
    "keys.direct.launch-missiles",
    "unknown direct command",
  ],
  ["[keys.direct]\nnew-task = true\n", "keys.direct.new-task", "expected a string"],
  [
    '[keys.direct]\nnew-task = "mod+ctrl+n"\n',
    "keys.direct.new-task",
    "already means ctrl or meta",
  ],
  ["[keys]\nprefix = 5\n", "keys.prefix", "expected a string, got a number"],
  ['[keys]\nprefix = ["alt+a"]\n', "keys.prefix", "expected a string, got an array"],
  ["[keys.bindings]\nnew-agent = true\n", "keys.bindings.new-agent", "expected a string"],
  ['[keys.bindings]\nlaunch-missiles = "m"\n', "keys.bindings.launch-missiles", "unknown action"],
  [
    '[keys.bindings]\nnew-agent = "hyper+a"\n',
    "keys.bindings.new-agent",
    'unknown modifier "hyper"',
  ],
  ['[keys]\nprefix = ""\n', "keys.prefix", "empty chord"],
];
test.for(rejected)("%s is rejected at %s", ([file, path, message]) => {
  const parsed = parseText(file);

  expect(parsed.config).toEqual(defaults);
  expect(parsed.problems).toHaveLength(1);
  expect(parsed.problems[0]).toMatchObject({ severity: "error", path });
  expect(parsed.problems[0]?.message).toContain(message);
});

test("an invalid entry is dropped while its neighbours still apply", () => {
  const { config, problems } = parseText(
    '[keys]\nprefix = "alt+b"\n[keys.bindings]\nnew-agent = "not a chord"\nboard = "z"\n',
  );

  expect(config.keys.prefix).toBe("alt+b");
  expect(config.keys.bindings["new-agent"]).toBe(DEFAULT_BINDINGS["new-agent"]);
  expect(config.keys.bindings["board"]).toBe("z");
  expect(problems.map((problem) => problem.path)).toEqual(["keys.bindings.new-agent"]);
});

test("a binding on the prefix chord is dropped, so the prefix keeps working", () => {
  const { config, problems } = parseText('[keys.bindings]\nnew-agent = "alt+a"\n');

  expect(config.keys.prefix).toBe(DEFAULT_PREFIX);
  expect(config.keys.bindings["new-agent"]).toBe(DEFAULT_BINDINGS["new-agent"]);
  expect(problems).toEqual([
    {
      severity: "error",
      path: "keys.bindings.new-agent",
      message: 'the chord "alt+a" is also used by the prefix',
    },
  ]);
});

test("a prefix on another action's chord falls back to the default prefix", () => {
  const { config, problems } = parseText('[keys]\nprefix = "c"\n');

  expect(config.keys.prefix).toBe(DEFAULT_PREFIX);
  expect(problems).toEqual([
    {
      severity: "error",
      path: "keys.prefix",
      message: 'the chord "c" is also used by new-terminal',
    },
  ]);
});

test("unbinding the action that holds the chord frees it for the prefix", () => {
  const { config, problems } = parseText(
    '[keys]\nprefix = "c"\n[keys.bindings]\nnew-terminal = ""\n',
  );

  expect(problems).toEqual([]);
  expect(config.keys.prefix).toBe("c");
  expect(config.keys.bindings["new-terminal"]).toBeNull();
});

test("two bindings on one chord are both dropped back to their defaults", () => {
  const { config, problems } = parseText('[keys.bindings]\nnew-agent = "z"\nboard = "z"\n');

  expect(config.keys.bindings["new-agent"]).toBe(DEFAULT_BINDINGS["new-agent"]);
  expect(config.keys.bindings["board"]).toBe(DEFAULT_BINDINGS["board"]);
  expect(problems).toEqual([
    {
      severity: "error",
      path: "keys.bindings.new-agent",
      message: 'the chord "z" is also used by board',
    },
    {
      severity: "error",
      path: "keys.bindings.board",
      message: 'the chord "z" is also used by new-agent',
    },
  ]);
});

test("a binding on another action's default chord is dropped", () => {
  const { config, problems } = parseText('[keys.bindings]\nnew-agent = "c"\n');

  expect(config.keys.bindings["new-agent"]).toBe(DEFAULT_BINDINGS["new-agent"]);
  expect(config.keys.bindings["new-terminal"]).toBe(DEFAULT_BINDINGS["new-terminal"]);
  expect(problems.map((problem) => problem.path)).toEqual(["keys.bindings.new-agent"]);
});

test("a chord freed by one drop can conflict again, and that conflict drops too", () => {
  const { config, problems } = parseText('[keys.bindings]\nnew-agent = "c"\nboard = "s"\n');

  expect(config).toEqual(defaults);
  expect(problems.map((problem) => problem.path)).toEqual([
    "keys.bindings.new-agent",
    "keys.bindings.board",
  ]);
});

const browserChords: [file: string, path: string, warns: boolean][] = [
  ['[keys.bindings]\nnew-agent = "ctrl+w"\n', "keys.bindings.new-agent", true],
  ['[keys.bindings]\nnew-agent = "meta+n"\n', "keys.bindings.new-agent", true],
  ['[keys.bindings]\nboard = "ctrl+shift+t"\n', "keys.bindings.board", true],
  ['[keys.bindings]\nboard = "ctrl+tab"\n', "keys.bindings.board", true],
  ['[keys]\nprefix = "ctrl+t"\n', "keys.prefix", true],
  // The prefix is already consumed when a binding fires, so a plain key is never browser-owned.
  ['[keys.bindings]\nnew-agent = "u"\n', "keys.bindings.new-agent", false],
  ['[keys.bindings]\nnew-agent = "y"\n', "keys.bindings.new-agent", false],
  // Alt takes a chord past the browser's own handling.
  ['[keys.bindings]\nnew-agent = "alt+ctrl+w"\n', "keys.bindings.new-agent", false],
];
test.for(browserChords)("%s warns only about browser-owned chords", ([file, path, warns]) => {
  const { config, problems } = parseText(file);

  expect({
    warnings: problems.filter((problem) => problem.severity === "warning").map((p) => p.path),
    errors: problems.filter((problem) => problem.severity === "error").map((p) => p.path),
    // A warning never drops the entry.
    applied: JSON.stringify(config) !== JSON.stringify(defaults),
  }).toEqual({ warnings: warns ? [path] : [], errors: [], applied: true });
});

test("arbitrary text never throws and always yields a valid state", () => {
  fc.assert(
    fc.property(fc.string(), (text) => {
      const { config, problems } = parseText(text);
      expect(ClientConfig.safeParse(config).success).toBe(true);
      for (const problem of problems) ConfigProblem.parse(problem);
    }),
  );
});

test("the defaults give every action its own chord", () => {
  // `conflictsOf` only drops entries written in the file, so two colliding defaults would
  // resolve silently to whichever action is listed last. The shipped keyboard must not have one.
  // Chords are compared as parsed chords, because two spellings of one chord still collide.
  const chords = ActionId.options.map((action) =>
    formatChord(parseChord(DEFAULT_BINDINGS[action])),
  );
  expect(new Set(chords).size).toBe(ActionId.options.length);
});

test("a binding on a chord no default uses is applied", () => {
  const freeChord = fc.constantFrom("f5", "f6", "shift+f8", "ctrl+f9", "alt+f10", "y");
  fc.assert(
    fc.property(fc.constantFrom(...ActionId.options), freeChord, (action, chord) => {
      const { config, problems } = parseText(`[keys.bindings]\n${action} = "${chord}"\n`);
      expect(problems).toEqual([]);
      expect(config.keys.bindings[action]).toBe(chord);
      expect(parseChord(config.keys.bindings[action] ?? "")).toEqual(parseChord(chord));
    }),
  );
});
