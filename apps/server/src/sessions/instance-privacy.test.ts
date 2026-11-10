import { ConfigState } from "@corral/protocol/config";
import type { ChatDriverRegistration } from "../chat/chat-driver.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { addProject } from "../../test/project-fixture.ts";
import { sessionsOf } from "../../test/session-helpers.ts";
import { useServer, within } from "../../test/server-fixture.ts";

/**
 * A driver whose frontend fails with the instance's literal value in its message. That is the one
 * place a value could reach an error: the launch wrapper must redact it before the message reaches
 * a client, a session's `launchError`, or the log.
 */
const failingPi: ChatDriverRegistration = {
  capabilities: {
    steer: false,
    followUp: false,
    approvals: false,
    modelSwitch: false,
    reasoningLevels: false,
    terminalView: "handoff-only",
  },
  args: () => [],
  create: (launch) => {
    throw new Error(`frontend refused with ${launch.env["INSTANCE_TOKEN"] ?? "no token"}`);
  },
};

const server = useServer({ chat: { drivers: { pi: failingPi } } });
useFakeAgents();
const SIZE = { cols: 80, rows: 24 };
const SECRET = "sk-instance-error-literal-4a17";

afterEach(() => vi.restoreAllMocks());

async function configure(): Promise<ConfigState> {
  await mkdir(server.configDir, { recursive: true });
  await writeFile(
    join(server.configDir, "config.toml"),
    `[profiles.secret]\nname = "Secret"\nagent = "pi"\nenv = [{ targetName = "INSTANCE_TOKEN", value = "${SECRET}" }]\n`,
  );
  const api = await server.rpc();
  const updates = await api.config.watch();
  try {
    return await within(
      (async () => {
        for await (const raw of updates) {
          const state = ConfigState.parse(raw);
          if (state.profiles.some((profile) => profile.id === "secret")) return state;
        }
        throw new Error("config.watch ended before the profile");
      })(),
      "the config",
    );
  } finally {
    await updates.return?.();
  }
}

test("a literal environment value never reaches a launch error, the session feed, the database's public row or a log", async () => {
  const logs: unknown[][] = [];
  vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args));
  vi.spyOn(console, "warn").mockImplementation((...args) => logs.push(args));
  vi.spyOn(console, "error").mockImplementation((...args) => logs.push(args));
  const state = await configure();
  expect(JSON.stringify(state)).not.toContain(SECRET);
  const { project } = await addProject(server);
  const api = await server.rpc();

  // A direct start refuses with the typed error; its rendered payload is the error text a client sees.
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Refused",
    workspace: { type: "main-worktree" },
  });
  const refused = await api.sessions
    .start({ taskId: task.id, kind: "pi", size: SIZE, profileId: "secret", view: "chat" })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  expect(refused).toMatchObject({
    code: "LAUNCH_FAILED",
    data: { kind: "pi", message: expect.stringContaining("[redacted]") },
  });
  expect(JSON.stringify(refused)).not.toContain(SECRET);

  // A primary launch that keeps its failed session exposes the same redacted sentence.
  const failedTask = await api.tasks.create({
    projectId: project.id,
    prompt: "Keep it",
    agent: { kind: "pi", profileId: "secret", view: "chat" },
    workspace: { type: "main-worktree" },
  });
  const failed = (await sessionsOf(api)).find(
    (session) => session.id === failedTask.primarySessionId,
  )!;
  expect(failed.state).toBe("stopped");
  expect(failed.launchError).toContain("[redacted]");
  expect(JSON.stringify(failed)).not.toContain(SECRET);
  expect(JSON.stringify(logs)).not.toContain(SECRET);

  const db = new DatabaseSync(join(server.dataDir, "corral.db"));
  try {
    const sessions = JSON.stringify(db.prepare("SELECT * FROM sessions").all());
    const privateRows = JSON.stringify(db.prepare("SELECT * FROM session_launch_specs").all());
    expect(sessions).not.toContain(SECRET);
    expect(privateRows).toContain(SECRET);
  } finally {
    db.close();
  }
});
