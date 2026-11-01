import {
  DEFAULT_BINDINGS,
  defaultAgentSettings,
  defaultClientConfig,
} from "@corral/protocol/config";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { eventually, useServer } from "../test/server-fixture.ts";
import { createConfigStore } from "./config-store.ts";
import { createConfigKeymap } from "./prefix-keymap.ts";
import type { ConnectionState } from "./connection-state.ts";
import type { RpcConnection } from "./rpc-connection.ts";
import { Store } from "./store.ts";

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
    config: defaultClientConfig(""),
    profiles: [],
    agents: [],
    problems: [],
  });

  await eventually(() => expect(client.config.getSnapshot().loaded).toBe(true));
  expect(client.config.getSnapshot()).toEqual({
    loaded: true,
    path: configFile(),
    config: defaultClientConfig(server.dataDir),
    profiles: [],
    agents: expect.any(Array),
    problems: [],
  });
  // Every agent comes with the host's answer: whether the command is executable and whether
  // this build can show it as chat.
  expect(client.config.getSnapshot().agents.map((agent) => agent.kind)).toEqual([
    "claude",
    "codex",
    "pi",
    "opencode",
  ]);
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
    expect(state.config).toEqual(defaultClientConfig(server.dataDir));
    expect(state.problems).toEqual([]);
  });
});

test("a pre-B5 config state gets the agent defaults and the newer bindings", async () => {
  // What a same-version daemon from before B5 puts on the wire: no `[agents]` table and an
  // exhaustive bindings record without the actions this client added. Nothing parses ConfigState
  // on the client, so the store has to fill the defaults the schema promises.
  const config = structuredClone(defaultClientConfig("/data"));
  Reflect.deleteProperty(config, "agents");
  for (const action of ["abort-turn", "change-model", "change-reasoning"]) {
    Reflect.deleteProperty(config.keys.bindings, action);
  }
  const wire = {
    path: "/home/me/.config/corral/config.toml",
    config,
    profiles: [],
    problems: [],
  };
  const state = new Store<ConnectionState>({ status: "connected" });
  const api = {
    config: {
      watch: async () =>
        (async function* () {
          yield wire;
        })(),
    },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a hand-built wire payload
  const connection = { state, api } as unknown as RpcConnection;
  const store = createConfigStore(connection);
  try {
    await vi.waitFor(() => expect(store.getSnapshot().loaded).toBe(true));
    const snapshot = store.getSnapshot();
    expect(snapshot.config.agents).toEqual(defaultAgentSettings());
    expect(snapshot.config.keys.bindings["change-model"]).toBe(DEFAULT_BINDINGS["change-model"]);
    expect(
      createConfigKeymap(snapshot.config).bindings.some(({ action }) => action === "change-model"),
    ).toBe(true);
  } finally {
    store.close();
  }
});
