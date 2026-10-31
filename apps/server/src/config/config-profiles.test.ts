import { DEFAULT_BINDINGS, DEFAULT_PREFIX } from "@corral/protocol/config";
import { expect, test } from "vite-plus/test";
import { defaultConfig, parseConfigFile } from "./config-file.ts";

const DATA_DIR = "/data";
const defaults = defaultConfig(DATA_DIR);
const parseText = (text: string) => parseConfigFile(text, DATA_DIR);

function onlyProfile(text: string) {
  const parsed = parseText(text);
  expect(parsed.problems).toEqual([]);
  expect(parsed.profiles).toHaveLength(1);
  return parsed.profiles[0]!;
}

test("a Claude profile with a model and environment references is a safe descriptor", () => {
  const profile = onlyProfile(`
[profiles.claude-gateway]
name = "Claude on gateway"
agent = "claude"
model = "claude-sonnet-4-5"
env = [
  { targetName = "ANTHROPIC_AUTH_TOKEN", fromEnv = "CORRAL_CLAUDE_TOKEN" },
  { targetName = "ANTHROPIC_BASE_URL", fromEnv = "CORRAL_CLAUDE_URL" },
]
`);

  expect(profile).toMatchObject({
    id: "claude-gateway",
    name: "Claude on gateway",
    agent: "claude",
    model: "claude-sonnet-4-5",
    provider: null,
    env: [
      { targetName: "ANTHROPIC_AUTH_TOKEN", fromEnv: "CORRAL_CLAUDE_TOKEN" },
      { targetName: "ANTHROPIC_BASE_URL", fromEnv: "CORRAL_CLAUDE_URL" },
    ],
  });
  expect(profile.revision).toMatch(/^[0-9a-f]{12}$/);
});

test("each supported model/provider pair is accepted; opencode is env-only", () => {
  const codex = onlyProfile(
    '[profiles.codex]\nname = "Codex"\nagent = "codex"\nmodel = "gpt-5-codex"\nprovider = "openai"\n',
  );
  expect(codex).toMatchObject({ model: "gpt-5-codex", provider: "openai" });

  const pi = onlyProfile(
    '[profiles.pi]\nname = "pi"\nagent = "pi"\nmodel = "anthropic/claude-sonnet-4:high"\nprovider = "anthropic"\n',
  );
  expect(pi).toMatchObject({ model: "anthropic/claude-sonnet-4:high", provider: "anthropic" });

  const opencode = onlyProfile(
    '[profiles.oc]\nname = "OpenCode"\nagent = "opencode"\nenv = [{ targetName = "OPENAI_API_KEY", fromEnv = "OPENAI_KEY" }]\n',
  );
  expect(opencode).toMatchObject({
    model: null,
    provider: null,
    env: [{ targetName: "OPENAI_API_KEY", fromEnv: "OPENAI_KEY" }],
  });
});

test("a revision follows the launch-relevant content", () => {
  const first = onlyProfile('[profiles.a]\nname = "A"\nagent = "claude"\nmodel = "one"\n').revision;
  const same = onlyProfile('[profiles.a]\nname = "A"\nagent = "claude"\nmodel = "one"\n').revision;
  const model = onlyProfile('[profiles.a]\nname = "A"\nagent = "claude"\nmodel = "two"\n').revision;
  const env = onlyProfile(
    '[profiles.a]\nname = "A"\nagent = "claude"\nmodel = "one"\nenv = [{ targetName = "TOKEN", fromEnv = "SERVER_TOKEN" }]\n',
  ).revision;

  expect(same).toBe(first);
  expect(model).not.toBe(first);
  expect(env).not.toBe(first);
});

test("profiles sit beside keys; an invalid key entry still drops only itself", () => {
  const parsed = parseText(`
[keys]
prefix = "ctrl+b"
[keys.bindings]
board = "q"
[profiles.p]
name = "P"
agent = "pi"
`);

  expect(parsed.problems).toEqual([]);
  expect(parsed.config.keys.prefix).toBe("ctrl+b");
  expect(parsed.config.keys.bindings["board"]).toBe("q");
  expect(parsed.profiles).toHaveLength(1);

  const broken = parseText(
    '[keys.bindings]\nboard = "hyper+q"\n[profiles.p]\nname = "P"\nagent = "pi"\n',
  );
  expect(broken.profiles).toHaveLength(1);
  expect(broken.problems).toHaveLength(1);
  expect(broken.config.keys.bindings["board"]).toBe(DEFAULT_BINDINGS["board"]);
});

const wholeProfileFailures: [name: string, body: string, message: string][] = [
  ["an unknown key", 'name = "P"\nagent = "claude"\nfavourite = "x"\n', "unknown key"],
  ["a missing name", 'agent = "claude"\n', "non-empty name"],
  ["a non-string name", 'name = 3\nagent = "claude"\n', "non-empty name"],
  ["an unknown agent", 'name = "P"\nagent = "grok"\n', "agent must be one of"],
  ["a bad model", 'name = "P"\nagent = "claude"\nmodel = "bad model"\n', "valid native model id"],
  [
    "a provider on claude",
    'name = "P"\nagent = "claude"\nprovider = "gateway"\n',
    "claude has no provider flag",
  ],
  [
    "a model on opencode",
    'name = "P"\nagent = "opencode"\nmodel = "gpt"\n',
    "opencode has no model flag",
  ],
  [
    "a provider on opencode",
    'name = "P"\nagent = "opencode"\nprovider = "openai"\n',
    "opencode has no provider flag",
  ],
  [
    "a pi provider without a model",
    'name = "P"\nagent = "pi"\nprovider = "anthropic"\n',
    "pi needs a model",
  ],
  [
    "a bad provider",
    'name = "P"\nagent = "codex"\nprovider = "not a provider"\n',
    "valid native provider id",
  ],
  [
    "an env literal value",
    'name = "P"\nagent = "claude"\nenv = [{ targetName = "TOKEN", fromEnv = "SERVER", value = "secret" }]\n',
    "literal values are not supported",
  ],
  ["a non-array env", 'name = "P"\nagent = "claude"\nenv = "TOKEN"\n', "env must be an array"],
  [
    "a malformed env target",
    'name = "P"\nagent = "claude"\nenv = [{ targetName = "BAD NAME", fromEnv = "SERVER" }]\n',
    "targetName must be",
  ],
  [
    "a malformed env source",
    'name = "P"\nagent = "claude"\nenv = [{ targetName = "TOKEN", fromEnv = "BAD NAME" }]\n',
    "fromEnv must be",
  ],
  [
    "a duplicate env target",
    'name = "P"\nagent = "claude"\nenv = [{ targetName = "TOKEN", fromEnv = "A" }, { targetName = "TOKEN", fromEnv = "B" }]\n',
    "same variable twice",
  ],
];

test.for(wholeProfileFailures)("%s drops the whole profile", ([, body, message]) => {
  const parsed = parseText(`[profiles.p]\n${body}`);
  expect(parsed.profiles).toEqual([]);
  expect(parsed.problems).toHaveLength(1);
  expect(parsed.problems[0]).toMatchObject({ severity: "error", path: "profiles.p" });
  expect(parsed.problems[0]?.message).toContain(message);
  expect(parsed.config).toEqual(defaults);
});

const reserved: string[] = [
  "CORRAL_SESSION_ID",
  "CORRAL_STATUS_TOKEN",
  "TERM",
  "PATH",
  "SHELL",
  "HOME",
  "XDG_CONFIG_HOME",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
  "BASH_ENV",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_PACKAGE_DIR",
  "MY_HOME",
  "SOME_CONFIG_THING",
];
test.for(reserved)("a profile may not set %s", (name) => {
  const parsed = parseText(
    `[profiles.p]\nname = "P"\nagent = "claude"\nenv = [{ targetName = "${name}", fromEnv = "SERVER_VALUE" }]\n`,
  );
  expect(parsed.profiles).toEqual([]);
  expect(parsed.problems[0]?.message).toBe("env may not set a reserved variable");
});

test("config problems never echo values or keys from the file", () => {
  const secret = "sk-live-should-never-appear";
  const parsed = parseText(`
[profiles.${"x".repeat(70)}]
name = "${secret}"
agent = "claude"
env = [{ targetName = "TOKEN", fromEnv = "${secret}" }]
`);
  expect(parsed.profiles).toEqual([]);
  expect(JSON.stringify(parsed)).not.toContain(secret);
  expect(parsed.problems).toEqual([
    expect.objectContaining({ path: "profiles", message: expect.not.stringContaining(secret) }),
  ]);

  const literal = parseText(
    `[profiles.p]\nname = "P"\nagent = "claude"\nenv = [{ targetName = "TOKEN", fromEnv = "SERVER", value = "${secret}" }]\n`,
  );
  expect(JSON.stringify(literal)).not.toContain(secret);
});

test("an invalid profile id is reported at the section, not by echoing the key", () => {
  const parsed = parseText(`[profiles."profile with spaces"]\nname = "P"\nagent = "claude"\n`);
  expect(parsed.profiles).toEqual([]);
  expect(parsed.problems).toEqual([
    {
      severity: "error",
      path: "profiles",
      message:
        "a profile id must be letters, digits, dot, underscore or dash, starting with a letter or digit",
    },
  ]);
});

test("an empty or missing profiles table leaves the defaults and the keys untouched", () => {
  expect(parseText("[profiles]\n")).toEqual({
    config: defaults,
    profiles: [],
    problems: [],
  });
  expect(parseText("[profiles]\np = 3\n").profiles).toEqual([]);
  expect(parseText("[profiles]\np = 3\n").problems[0]).toMatchObject({
    path: "profiles.p",
    message: "expected a table, got a number",
  });
  expect(DEFAULT_PREFIX).toBe(defaults.keys.prefix);
});
