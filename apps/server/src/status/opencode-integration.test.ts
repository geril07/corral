import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { OpenCodeIntegration } from "./opencode-integration.ts";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "corral-integration-"));
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const PLUGIN = join("agent-integrations", "opencode", "corral-status", "index.js");
const source = () => readFile(new URL("./opencode-plugin/index.js", import.meta.url), "utf8");

test("installing writes the plugin into the data directory", async () => {
  OpenCodeIntegration.install(dataDir);

  expect(await readFile(join(dataDir, PLUGIN), "utf8")).toBe(await source());
});

test("installing replaces a plugin that differs, e.g. one left by an older server", async () => {
  await mkdir(join(dataDir, PLUGIN, ".."), { recursive: true });
  await writeFile(join(dataDir, PLUGIN), "// an older version");

  OpenCodeIntegration.install(dataDir);

  expect(await readFile(join(dataDir, PLUGIN), "utf8")).toBe(await source());
});

test("installing leaves a plugin that is already current alone", async () => {
  OpenCodeIntegration.install(dataDir);
  const before = await stat(join(dataDir, PLUGIN));

  OpenCodeIntegration.install(dataDir);

  expect((await stat(join(dataDir, PLUGIN))).ino).toBe(before.ino);
});

test("the launch loads the plugin directory through inline config and runs OpenCode standalone", () => {
  const launch = OpenCodeIntegration.install(dataDir).launch({});

  expect(launch?.args).toEqual(["--standalone"]);
  expect(JSON.parse(launch!.env["OPENCODE_CONFIG_CONTENT"]!)).toEqual({
    plugins: [{ package: join(dataDir, "agent-integrations", "opencode", "corral-status") }],
  });
});

test("the user's own OPENCODE_CONFIG_DIR and OPENCODE_CONFIG are left alone and still apply next to the plugin", () => {
  const launch = OpenCodeIntegration.install(dataDir).launch({
    OPENCODE_CONFIG_DIR: "/home/me/dotfiles/opencode",
    OPENCODE_CONFIG: "/home/me/opencode.json",
  });

  expect(launch?.env).not.toHaveProperty("OPENCODE_CONFIG_DIR");
  expect(launch?.env).not.toHaveProperty("OPENCODE_CONFIG");
});

test("a plugin that cannot be written is not fatal: OpenCode just starts without it", async () => {
  await writeFile(join(dataDir, "agent-integrations"), "in the way");
  const error = vi.spyOn(console, "error").mockImplementation(() => {});

  const integration = OpenCodeIntegration.install(dataDir);

  expect(integration.launch({})).toBeUndefined();
  expect(error).toHaveBeenCalledOnce();
  error.mockRestore();
});
