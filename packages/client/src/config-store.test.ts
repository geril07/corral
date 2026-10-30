import { DEFAULT_BINDINGS, DEFAULT_PREFIX } from "@corral/protocol/config";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { defaultConfig } from "./config-store.ts";
import { eventually, useServer } from "../test/server-fixture.ts";

const server = useServer();
const configDir = () => process.env["CORRAL_CONFIG_DIR"] ?? "";
const configFile = () => join(configDir(), "config.toml");

async function writeConfig(text: string) {
  await mkdir(configDir(), { recursive: true });
  await writeFile(configFile(), text);
}

test("starts with the defaults, before the server has sent the config and without a file", async () => {
  const client = server.connect();
  expect(client.config.getSnapshot()).toEqual({
    loaded: false,
    path: "",
    config: defaultConfig(),
    problems: [],
  });

  await eventually(() => expect(client.config.getSnapshot().loaded).toBe(true));
  expect(client.config.getSnapshot()).toEqual({
    loaded: true,
    path: configFile(),
    config: {
      keys: { prefix: DEFAULT_PREFIX, bindings: { ...DEFAULT_BINDINGS } },
    },
    problems: [],
  });
});

test("a written config file changes the store", async () => {
  const client = await server.connected();
  await eventually(() => expect(client.config.getSnapshot().loaded).toBe(true));

  await writeConfig('[keys]\nprefix = "ctrl+b"\n\n[keys.bindings]\nnew-agent = "a"\nboard = ""\n');

  await eventually(() => {
    const state = client.config.getSnapshot();
    expect(state.config.keys.prefix).toBe("ctrl+b");
    expect(state.config.keys.bindings["new-agent"]).toBe("a");
    expect(state.config.keys.bindings["board"]).toBeNull();
    expect(state.problems).toEqual([]);
  });
});

test("problems from an invalid file arrive with the defaults kept", async () => {
  const client = await server.connected();
  await eventually(() => expect(client.config.getSnapshot().loaded).toBe(true));

  await writeConfig('[keys.bindings]\nnew-agent = "hyper+q"\n');

  await eventually(() => {
    const state = client.config.getSnapshot();
    expect(state.config.keys.bindings["new-agent"]).toBe(DEFAULT_BINDINGS["new-agent"]);
    expect(state.problems).toEqual([
      {
        severity: "error",
        path: "keys.bindings.new-agent",
        message: 'unknown modifier "hyper" in "hyper+q"',
      },
    ]);
  });
});

test("deleting the file goes back to the defaults", async () => {
  const client = await server.connected();
  await eventually(() => expect(client.config.getSnapshot().loaded).toBe(true));
  await writeConfig('[keys]\nprefix = "ctrl+b"\n');
  await eventually(() => expect(client.config.getSnapshot().config.keys.prefix).toBe("ctrl+b"));

  await rm(configFile());

  await eventually(() => {
    const state = client.config.getSnapshot();
    expect(state.config).toEqual(defaultConfig());
    expect(state.problems).toEqual([]);
  });
});
