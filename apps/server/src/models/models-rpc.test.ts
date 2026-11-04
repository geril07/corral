import { defaultModelPolicy, modelVisible } from "@corral/protocol/models";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { useServer, within } from "../../test/server-fixture.ts";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { addProject } from "../../test/project-fixture.ts";
import { processExists } from "../../test/session-helpers.ts";

const server = useServer({ modelCatalogTimeoutMs: 2000 });
const agents = useFakeAgents();
const scope = { kind: "pi" as const, profileId: null };

test("shared preferences watch/save conflict and survive restart without native launches", async () => {
  const a = await server.rpc(),
    b = await server.rpc();
  const stream = await b.models.watch();
  const iterator = stream[Symbol.asyncIterator]();
  expect((await within(iterator.next(), "initial preferences")).value).toEqual([]);
  const policy = {
    ...defaultModelPolicy(),
    mode: "allow" as const,
    allow: [{ type: "provider" as const, provider: "work" }],
  };
  const saved = await a.models.save({ scope, revision: 0, policy });
  expect(saved.revision).toBe(1);
  expect((await within(iterator.next(), "shared update")).value).toEqual([saved]);
  await expect(
    b.models.save({ scope, revision: 0, policy: defaultModelPolicy() }),
  ).rejects.toMatchObject({ code: "MODEL_PREFERENCES_CHANGED" });
  await a.models.save({
    scope: { kind: "pi", profileId: "personal" },
    revision: 0,
    policy: defaultModelPolicy(),
  });
  expect(await agents.launches()).toEqual([]);
  await server.restart();
  const api = await server.rpc();
  const restored = await api.models.watch();
  const records = (await restored[Symbol.asyncIterator]().next()).value;
  expect(records).toContainEqual(saved);
  expect(records).toHaveLength(2);
});

test("pi discovery is deduplicated, scoped to the workspace and leaves no task/session/native process", async () => {
  const { project } = await addProject(server, "catalog");
  const api = await server.rpc();
  const input = { scope, context: { projectId: project.id } };
  const [a, b] = await Promise.all([api.models.catalog(input), api.models.catalog(input)]);
  expect(a).toEqual(b);
  expect(a.status).toBe("ready");
  expect(a.models.map((m) => m.id)).toEqual(["stub-1", "stub-2"]);
  expect(await api.models.catalog(input)).toEqual(a);
  const launches = (await agents.launches()).filter((l) => l.argv.includes("--no-session"));
  expect(launches).toHaveLength(1);
  expect(launches[0]).toMatchObject({ cwd: project.path, env: {} });
  expect(launches[0]!.argv).toEqual(["--mode", "rpc", "--no-session"]);
  expect(processExists(launches[0]!.pid)).toBe(false);
  const tasks = await api.tasks.watch();
  expect((await tasks[Symbol.asyncIterator]().next()).value).toEqual([]);
  const sessions = await api.sessions.watch();
  expect((await sessions[Symbol.asyncIterator]().next()).value).toEqual([]);
});

test("new discovery models obey saved provider rules; failed refresh keeps inventory and hides native diagnostics", async () => {
  const { project } = await addProject(server, "refresh");
  const api = await server.rpc();
  const input = { scope, context: { projectId: project.id } };
  const first = await api.models.catalog(input);
  const saved = await api.models.save({
    scope,
    revision: 0,
    policy: {
      ...defaultModelPolicy(),
      mode: "allow",
      allow: [{ type: "provider", provider: "stub" }],
    },
  });
  await mkdir(agents.piRpcHome, { recursive: true });
  await writeFile(join(agents.piRpcHome, "catalog-extra"), "");
  const next = await api.models.catalog({ ...input, refresh: true });
  expect(next.models).toHaveLength(first.models.length + 1);
  expect(modelVisible(saved.policy, next.models.at(-1)!)).toBe(true);
  await writeFile(join(agents.piRpcHome, "catalog-error"), "");
  const stale = await api.models.catalog({ ...input, refresh: true });
  expect(stale.status).toBe("stale");
  expect(stale.models).toEqual(next.models);
  expect(JSON.stringify(stale)).not.toContain("secret-native-diagnostic");
});

test("OpenCode probes its own server, gets enabled provider/model identities and never creates a conversation", async () => {
  const { project } = await addProject(server, "opencode-catalog");
  const api = await server.rpc();
  const catalog = await api.models.catalog({
    scope: { kind: "opencode", profileId: null },
    context: { projectId: project.id },
  });
  expect(catalog.status).toBe("ready");
  expect(catalog.models).toEqual([
    { provider: "stub", id: "stub-model", name: "Stub Model" },
    { provider: "other", id: "other-model", name: "Other Model" },
  ]);
  const journal = await readFile(agents.openCodeLog, "utf8");
  expect(journal).toContain('"action":"model-list"');
  expect(journal).not.toContain('"action":"session-create"');
  for (const launch of await agents.launches()) expect(processExists(launch.pid)).toBe(false);
});

test("partial OpenCode refreshes retain useful models and saved rules, while growing catalogs settle", async () => {
  const { project } = await addProject(server, "partial");
  const api = await server.rpc();
  const input = {
    scope: { kind: "opencode" as const, profileId: null },
    context: { projectId: project.id },
  };
  const full = await api.models.catalog(input);
  await mkdir(agents.openCodeState, { recursive: true });
  await writeFile(join(agents.openCodeState, "catalog-mode"), "partial-error");
  const partial = await api.models.catalog({ ...input, refresh: true });
  expect(partial.status).toBe("partial");
  expect(partial.models).toEqual(full.models);
  await writeFile(join(agents.openCodeState, "catalog-mode"), "growing");
  const growing = await api.models.catalog({ ...input, refresh: true });
  expect(growing.status).toBe("ready");
  expect(growing.models).toEqual(full.models);
});

test("separate profiles resolve their own references, reject stale revisions, and never expose values", async () => {
  const { project } = await addProject(server, "profiles");
  const api = await server.rpc();
  vi.stubEnv("CATALOG_PERSONAL", "personal-secret");
  vi.stubEnv("CATALOG_WORK", "work-secret");
  vi.stubEnv("FAKE_AGENT_LOG_ENV", "DISCOVERY_ACCOUNT");
  await mkdir(server.configDir, { recursive: true });
  await writeFile(
    join(server.configDir, "config.toml"),
    `
[profiles.personal]
name = "Personal"
agent = "pi"
env = [{ targetName = "DISCOVERY_ACCOUNT", fromEnv = "CATALOG_PERSONAL" }]
[profiles.work]
name = "Work"
agent = "pi"
env = [{ targetName = "DISCOVERY_ACCOUNT", fromEnv = "CATALOG_WORK" }]
`,
  );
  const config = await within(
    (async () => {
      for await (const state of await api.config.watch())
        if (state.profiles.length === 2) return state;
      throw new Error("config watch ended");
    })(),
    "profiles",
  );
  const input = (id: string) => ({
    scope: { kind: "pi" as const, profileId: id },
    context: { projectId: project.id },
    expectedProfileRevision: config.profiles.find((p) => p.id === id)!.revision,
  });
  const results = await Promise.all([
    api.models.catalog(input("personal")),
    api.models.catalog(input("work")),
  ]);
  expect(results.map((result) => result.status)).toEqual(["ready", "ready"]);
  const launches = await agents.launches();
  expect(
    launches
      .map((l) => l.envSentinels["DISCOVERY_ACCOUNT"])
      .toSorted((a, b) => (a ?? "").localeCompare(b ?? "")),
  ).toEqual(["personal-secret", "work-secret"]);
  expect(JSON.stringify(results)).not.toContain("-secret");
  const stale = await api.models.catalog({ ...input("work"), expectedProfileRevision: "stale" });
  expect(stale.status).toBe("error");
  expect(await agents.launches()).toHaveLength(2);
});

test("shutdown stops an unanswered metadata process and releases its native claim", async () => {
  const { project } = await addProject(server, "shutdown");
  const api = await server.rpc();
  vi.stubEnv("FAKE_PI_RPC", "silent");
  const pending = api.models
    .catalog({ scope, context: { projectId: project.id } })
    .catch(() => undefined);
  await expect.poll(async () => (await agents.launches()).length).toBe(1);
  const launch = (await agents.launches())[0]!;
  await server.restart();
  await pending;
  expect(processExists(launch.pid)).toBe(false);
});

test("unsupported, removed-profile and missing-context reads never spawn a native process", async () => {
  const api = await server.rpc();
  expect(
    (await api.models.catalog({ scope: { kind: "codex", profileId: null }, context: {} })).status,
  ).toBe("unsupported");
  expect(
    (await api.models.catalog({ scope: { kind: "pi", profileId: "gone" }, context: {} })).status,
  ).toBe("error");
  expect((await api.models.catalog({ scope, context: { taskId: "gone" } })).status).toBe("error");
  expect(await agents.launches()).toEqual([]);
});
