import { ConfigState } from "@corral/protocol/config";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { addTask } from "../../test/project-fixture.ts";
import { useServer, within } from "../../test/server-fixture.ts";
import { launchesOf, sessionsOf } from "../../test/session-helpers.ts";

// A rare native failure: the real node-pty spawn succeeds for the first launch, then the test
// asks the third-party boundary to throw with the resolved token in its message. Corral's
// service, redaction and RPC router are real.
vi.mock("node-pty", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node-pty")>();
  return {
    ...actual,
    spawn: (...parameters: Parameters<typeof actual.spawn>) => {
      const [file, , options] = parameters;
      if (process.env["FAIL_NATIVE_SPAWN"] === "1" && file === "claude") {
        const token = options.env?.["ANTHROPIC_AUTH_TOKEN"] ?? "";
        throw Object.assign(new Error(`native spawn failed with token ${token}`), {
          code: "E2BIG",
        });
      }
      return actual.spawn(...parameters);
    },
  };
});

const server = useServer();
const agents = useFakeAgents();
const SIZE = { cols: 80, rows: 24 };
const SENTINEL = "sk-native-error-secret-4a91";
const configFile = () => join(server.configDir, "config.toml");

afterEach(() => vi.restoreAllMocks());

async function writeProfile(): Promise<void> {
  await mkdir(server.configDir, { recursive: true });
  await writeFile(
    configFile(),
    `[profiles.claude-gateway]
name = "Claude gateway"
agent = "claude"
model = "claude-sonnet-4-5"
env = [{ targetName = "ANTHROPIC_AUTH_TOKEN", fromEnv = "LAUNCH_SPAWN_TOKEN" }]
`,
  );
  const api = await server.rpc();
  const updates = await api.config.watch();
  try {
    await within(
      (async () => {
        for await (const raw of updates) {
          if (ConfigState.parse(raw).profiles.some((profile) => profile.id === "claude-gateway"))
            return;
        }
        throw new Error("config.watch ended");
      })(),
      "the launch profile",
    );
  } finally {
    await updates.return?.();
  }
}

test("a real RPC LAUNCH_FAILED carries a redacted, useful diagnostic and no sentinel anywhere", async () => {
  vi.stubEnv("LAUNCH_SPAWN_TOKEN", SENTINEL);
  await writeProfile();
  const { api, task } = await addTask(server, "Native failure");
  const session = await api.sessions.start({
    taskId: task.id,
    kind: "claude",
    size: SIZE,
    profileId: "claude-gateway",
  });
  await launchesOf(agents, "claude", 1);
  expect(JSON.stringify(session)).not.toContain(SENTINEL);

  const logs: unknown[][] = [];
  vi.spyOn(console, "error").mockImplementation((...args) => logs.push(args));
  vi.stubEnv("FAIL_NATIVE_SPAWN", "1");

  await server.restart();
  const afterRestore = await server.rpc();
  const restored = (await sessionsOf(afterRestore))[0]!;
  expect(restored).toMatchObject({ id: session.id, state: "stopped", terminalId: null });
  expect(restored.launchError).toContain("E2BIG");
  expect(restored.launchError).not.toContain(SENTINEL);
  expect(JSON.stringify(restored)).not.toContain(SENTINEL);
  expect(JSON.stringify(logs)).not.toContain(SENTINEL);
  expect(JSON.stringify(logs)).toContain("E2BIG");
  expect(await launchesOf(agents, "claude", 1)).toHaveLength(1);

  let restartError: unknown;
  try {
    await afterRestore.sessions.restart({ id: session.id, size: SIZE });
  } catch (error) {
    restartError = error;
  }
  expect(restartError).toMatchObject({
    code: "LAUNCH_FAILED",
    data: { kind: "claude", message: expect.stringContaining("E2BIG") },
  });
  expect(JSON.stringify(restartError)).not.toContain(SENTINEL);
  expect(failureMessage(restartError)).not.toContain("\n");
  expect(JSON.stringify(logs.at(-1))).not.toContain(SENTINEL);

  let startError: unknown;
  try {
    await afterRestore.sessions.start({
      taskId: task.id,
      kind: "claude",
      size: SIZE,
      profileId: "claude-gateway",
    });
  } catch (error) {
    startError = error;
  }
  expect(startError).toMatchObject({
    code: "LAUNCH_FAILED",
    data: { kind: "claude", message: expect.stringContaining("E2BIG") },
  });
  expect(JSON.stringify(startError)).not.toContain(SENTINEL);
  expect(failureMessage(startError)).not.toContain("\n");
  const finalError = (await sessionsOf(afterRestore))[0]!.launchError;
  expect(finalError).toContain("E2BIG");
  expect(finalError).not.toContain(SENTINEL);
});

function failureMessage(error: unknown): string {
  if (typeof error !== "object" || error === null || !("data" in error)) {
    throw new Error("the RPC error has no data");
  }
  const data = error.data;
  if (typeof data !== "object" || data === null || !("message" in data)) {
    throw new Error("the RPC error has no message");
  }
  if (typeof data.message !== "string") throw new Error("the RPC error message is not a string");
  return data.message;
}
