import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { ConfigState } from "@corral/protocol/config";
import { FAKE_BIN, useFakeAgents } from "../../test/fake-agents.ts";
import { addProject } from "../../test/project-fixture.ts";
import { useServer, within } from "../../test/server-fixture.ts";

const server = useServer({ modelCatalogTimeoutMs: 2000 });
const agents = useFakeAgents();

async function wrapper(name: string, binary: string) {
  const file = join(server.scratchDir, name);
  await writeFile(
    file,
    `#!/bin/sh\nexport INSTANCE_WRAPPER="${name}"\nexec "${join(FAKE_BIN, binary)}" "$@"\n`,
  );
  await chmod(file, 0o700);
  return file;
}

test("named Pi metadata uses isolated executable, argv and private environment across edits", async () => {
  const one = await wrapper("pi-one", "pi");
  const two = await wrapper("pi-two", "pi");
  const { project } = await addProject(server, "instance-catalog");
  const api = await server.rpc();
  vi.stubEnv("FAKE_AGENT_LOG_ENV", "DISCOVERY_ACCOUNT,PI_CODING_AGENT_DIR,INSTANCE_WRAPPER");
  vi.stubEnv("PRIVATE_PI_ROOT", "~/private-pi-root");
  const contents = (secret: string, firstArgs = '["--no-skills"]') => `
[profiles.one]
name = "One"
agent = "pi"
command = "${one}"
args = ${firstArgs}
model = "stub-1"
provider = "stub"
env = [{ targetName = "DISCOVERY_ACCOUNT", value = "${secret}" }, { targetName = "PI_CODING_AGENT_DIR", fromEnv = "PRIVATE_PI_ROOT" }]
[profiles.two]
name = "Two"
agent = "pi"
command = "${two}"
args = ["--no-extensions"]
env = [{ targetName = "DISCOVERY_ACCOUNT", value = "second-private" }, { targetName = "PI_CODING_AGENT_DIR", value = "/isolated/two" }]
[profiles.disabled]
name = "Disabled"
agent = "pi"
enabled = false
`;
  await mkdir(server.configDir, { recursive: true });
  const file = join(server.configDir, "config.toml");
  const stream = await api.config.watch();
  const iterator = stream[Symbol.asyncIterator]();
  await iterator.next();
  await writeFile(file, contents("first-private"));
  const initial = ConfigState.parse((await within(iterator.next(), "instance config")).value);
  const input = (id: string) => ({
    scope: { kind: "pi" as const, profileId: id },
    context: { projectId: project.id },
  });
  const [first, second] = await Promise.all([
    api.models.catalog(input("one")),
    api.models.catalog(input("two")),
  ]);
  expect([first.status, second.status]).toEqual(["ready", "ready"]);
  expect(JSON.stringify([initial, first, second])).not.toContain("private");
  const launches = await agents.launches();
  expect(launches).toHaveLength(2);
  const a = launches.find((entry) => entry.argv.includes("--no-skills"))!;
  const b = launches.find((entry) => entry.argv.includes("--no-extensions"))!;
  expect(a.cwd).toBe(project.path);
  expect(a.argv).toEqual([
    "--no-skills",
    "--mode",
    "rpc",
    "--no-session",
    "--provider",
    "stub",
    "--model",
    "stub-1",
  ]);
  expect(a.envSentinels).toMatchObject({
    INSTANCE_WRAPPER: "pi-one",
    DISCOVERY_ACCOUNT: "first-private",
    PI_CODING_AGENT_DIR: join(process.env["HOME"]!, "private-pi-root"),
  });
  expect(b.envSentinels).toMatchObject({
    INSTANCE_WRAPPER: "pi-two",
    DISCOVERY_ACCOUNT: "second-private",
    PI_CODING_AGENT_DIR: "/isolated/two",
  });
  await api.models.catalog(input("one"));
  expect(await agents.launches()).toHaveLength(2);
  vi.stubEnv("PRIVATE_PI_ROOT", "~/other-pi-root");
  expect((await api.models.catalog(input("one"))).status).toBe("ready");
  expect(await agents.launches()).toHaveLength(3);
  expect((await api.models.catalog(input("disabled"))).status).toBe("error");
  expect((await api.models.catalog(input("missing"))).status).toBe("error");
  expect(await agents.launches()).toHaveLength(3);
  const tasks = await api.tasks.watch();
  expect((await tasks[Symbol.asyncIterator]().next()).value).toEqual([]);
  const sessions = await api.sessions.watch();
  expect((await sessions[Symbol.asyncIterator]().next()).value).toEqual([]);
  await writeFile(file, contents("changed-private"));
  const edited = ConfigState.parse(
    (await within(iterator.next(), "changed instance config")).value,
  );
  expect(edited.profiles[0]?.revision).not.toBe(initial.profiles[0]?.revision);
  expect((await api.models.catalog(input("one"))).status).toBe("ready");
  expect(await agents.launches()).toHaveLength(4);
  await writeFile(file, contents("changed-private", '["--mode=rpc"]'));
  await within(iterator.next(), "invalid instance args");
  const rejected = await api.models.catalog(input("one"));
  expect(rejected.status).toBe("error");
  expect(JSON.stringify(rejected)).not.toContain("changed-private");
  expect(await agents.launches()).toHaveLength(4);
  await writeFile(file, contents("changed-private", '["--model", "other"]'));
  await within(iterator.next(), "conflicting model args");
  expect((await api.models.catalog(input("one"))).status).toBe("error");
  expect(await agents.launches()).toHaveLength(4);
  await iterator.return?.();
});

test("native metadata that echoes a private value cannot expose it as a model", async () => {
  const { project } = await addProject(server, "instance-redaction");
  const api = await server.rpc();
  await mkdir(agents.piRpcHome, { recursive: true });
  await writeFile(
    join(agents.piRpcHome, "catalog.json"),
    JSON.stringify([
      { id: "normal", name: "echo my-private-value", provider: "stub" },
      { id: "my-private-value", name: "bad id", provider: "stub" },
      { id: "bad-provider", name: "bad provider", provider: "my-private-value" },
    ]),
  );
  await mkdir(server.configDir, { recursive: true });
  const stream = await api.config.watch();
  const iterator = stream[Symbol.asyncIterator]();
  await iterator.next();
  await writeFile(
    join(server.configDir, "config.toml"),
    '[profiles.p]\nname = "P"\nagent = "pi"\nenv = [{ targetName = "TOKEN", value = "my-private-value" }]\n',
  );
  await within(iterator.next(), "private config");
  const catalog = await api.models.catalog({
    scope: { kind: "pi", profileId: "p" },
    context: { projectId: project.id },
  });
  expect(catalog.status).toBe("ready");
  expect(catalog.models).toEqual([{ id: "normal", name: "echo [redacted]", provider: "stub" }]);
  expect(JSON.stringify(catalog)).not.toContain("my-private-value");
  await iterator.return?.();
});

test("OpenCode named metadata uses the instance command and env, refusing extra argv", async () => {
  const command = await wrapper("opencode-instance", "opencode");
  const { project } = await addProject(server, "instance-opencode");
  const api = await server.rpc();
  vi.stubEnv("FAKE_AGENT_LOG_ENV", "DISCOVERY_ACCOUNT,INSTANCE_WRAPPER");
  await mkdir(server.configDir, { recursive: true });
  const file = join(server.configDir, "config.toml");
  const config = (args: string) =>
    `[profiles.oc]\nname = "OC"\nagent = "opencode"\ncommand = "${command}"\nargs = ${args}\nenv = [{ targetName = "DISCOVERY_ACCOUNT", value = "oc-private" }]\n`;
  const stream = await api.config.watch();
  const iterator = stream[Symbol.asyncIterator]();
  await iterator.next();
  await writeFile(file, config("[]"));
  await within(iterator.next(), "OpenCode instance");
  const input = {
    scope: { kind: "opencode" as const, profileId: "oc" },
    context: { projectId: project.id },
  };
  const result = await api.models.catalog(input);
  expect(result.status).toBe("ready");
  expect(JSON.stringify(result)).not.toContain("oc-private");
  expect((await agents.launches())[0]?.envSentinels).toMatchObject({
    DISCOVERY_ACCOUNT: "oc-private",
    INSTANCE_WRAPPER: "opencode-instance",
  });
  expect(await readFile(agents.openCodeLog, "utf8")).toContain('"action":"model-list"');
  await writeFile(file, config('["--verbose"]'));
  await within(iterator.next(), "OpenCode args edit");
  expect((await api.models.catalog(input)).status).toBe("error");
  expect(await agents.launches()).toHaveLength(1);
  await iterator.return?.();
});
