import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { parseConfigFile } from "./config-file.ts";
import { watchConfigFile } from "./config-watcher.ts";

const config = (secret: string) => `
[agents.pi]
command = "/default/pi"
[profiles.one]
name = "First"
agent = "pi"
command = "/one/pi"
args = ["--verbose"]
env = [{ targetName = "TOKEN", value = "${secret}" }, { targetName = "PI_CODING_AGENT_DIR", value = "~/one" }, { targetName = "OTHER", fromEnv = "SOURCE" }]
[profiles.two]
name = "Second"
agent = "pi"
args = ["--quiet"]
enabled = false
env = [{ targetName = "TOKEN", value = "second-secret" }, { targetName = "CODEX_HOME", fromEnv = "ROOT" }, { targetName = "PLAIN", value = "~/unchanged" }]
`;
const descriptor = (text: string) => parseConfigFile(text, "/data").profiles[0]!;

test("private instances resolve separately and edits update the public revision", async () => {
  const dir = mkdtempSync(join(tmpdir(), "instance-config-"));
  const file = join(dir, "config.toml");
  writeFileSync(file, config("first-secret"));
  const watcher = watchConfigFile(file, { dataDir: dir });
  const controller = new AbortController();
  const updates = watcher.watch(controller.signal);
  try {
    const initial = (await updates.next()).value!;
    expect(initial.problems).toEqual([]);
    expect(JSON.stringify(initial)).not.toContain("first-secret");
    expect(JSON.stringify(initial)).not.toContain("second-secret");
    expect(initial.profiles[1]?.enabled).toBe(false);
    const source = {
      TOKEN: "inherited",
      SOURCE: "reference",
      ROOT: "~/codex",
      PI_CODING_AGENT_DIR: "/inherited",
    };
    expect(watcher.resolveInstance("one", source, "/server-home")).toMatchObject({
      command: "/one/pi",
      args: ["--verbose"],
      env: { TOKEN: "first-secret", OTHER: "reference", PI_CODING_AGENT_DIR: "/server-home/one" },
    });
    expect(watcher.resolveInstance("two", source, "/server-home")).toMatchObject({
      command: "/default/pi",
      args: ["--quiet"],
      enabled: false,
      env: { TOKEN: "second-secret", CODEX_HOME: "/server-home/codex", PLAIN: "~/unchanged" },
    });
    expect(source.TOKEN).toBe("inherited");
    expect(() => watcher.resolveInstance("one", {}, "/server-home")).toThrow("SOURCE");
    const next = updates.next();
    writeFileSync(file, config("changed-secret"));
    const changed = (await next).value!;
    expect(changed.profiles[0]?.revision).not.toBe(initial.profiles[0]?.revision);
    expect(JSON.stringify(changed)).not.toContain("changed-secret");
    expect(watcher.resolveInstance("one", source, "/server-home")?.env.TOKEN).toBe(
      "changed-secret",
    );
  } finally {
    controller.abort();
    await updates.return(undefined);
    watcher.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("instance identity survives renames and revisions cover each new field", () => {
  const base = '[profiles.stable]\nname = "First"\nagent = "pi"\n';
  const original = descriptor(base);
  const renamed = descriptor(base.replace("First", "Renamed"));
  expect(renamed.id).toBe(original.id);
  for (const extra of [
    'command = "/opt/pi"\n',
    'args = ["--verbose"]\n',
    "enabled = false\n",
    'env = [{ targetName = "TOKEN", value = "private" }]\n',
  ])
    expect(descriptor(base + extra).revision).not.toBe(original.revision);
});

test("invalid literal sources and malformed TOML never enter public diagnostics", () => {
  const secret = "secret-never-public";
  for (const env of [
    `{ targetName = "TOKEN", value = "${secret}", fromEnv = "SOURCE" }`,
    `{ targetName = "TOKEN" }`,
    `{ targetName = "TOKEN", value = "${secret}" }, { targetName = "TOKEN", value = "x" }`,
    `{ targetName = "NODE_OPTIONS", value = "${secret}" }`,
  ]) {
    const parsed = parseConfigFile(
      `[profiles.p]\nname = "P"\nagent = "pi"\nenv = [${env}]`,
      "/data",
    );
    expect(parsed.profiles).toEqual([]);
    expect(parsed.problems.length).toBeGreaterThan(0);
    expect(JSON.stringify(parsed.problems)).not.toContain(secret);
  }
  const invalid = parseConfigFile(
    `[profiles.p]\nenv = [ { value = "${secret}" broken } ]`,
    "/data",
  );
  expect(JSON.stringify(invalid.problems)).not.toContain(secret);
});
