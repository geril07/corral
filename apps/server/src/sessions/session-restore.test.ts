import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { FAKE_BIN, useFakeAgents } from "../../test/fake-agents.ts";
import { addTask } from "../../test/project-fixture.ts";
import { useServer } from "../../test/server-fixture.ts";
import { frontendArgs, launchesOf, sessionsOf, tuiLaunchesOf } from "../../test/session-helpers.ts";

const server = useServer();
const agents = useFakeAgents();
const SIZE = { cols: 80, rows: 24 };
// Restarts a real server and resumes five agents; the fixture readiness deadline is 15s.
const RESTART_TIMEOUT_MS = 20_000;

afterEach(() => vi.restoreAllMocks());

test(
  "after a server restart, running sessions start again — agents resumed by id, a shell fresh — and stopped ones stay stopped",
  async () => {
    vi.stubEnv("SHELL", "/bin/sh");
    const { api, task } = await addTask(server, "Survivors");
    const start = (kind: "shell" | "claude" | "codex" | "pi" | "opencode") =>
      api.sessions.start({ taskId: task.id, kind, size: SIZE });
    const shell = await start("shell");
    const claude = await start("claude");
    // Resuming needs a conversation, which Claude Code only has after the first prompt.
    const claudeClient = await server.attach(claude.terminalId!);
    await claudeClient.waitForScreen("fake claude ready");
    claudeClient.type("hello\n");
    await claudeClient.waitForScreen("fake claude got: hello");
    const pi = await start("pi");
    const opencode = await start("opencode");
    const codex = await start("codex");
    const stopped = await start("claude");
    await launchesOf(agents, "claude", 2);
    await api.sessions.stop({ id: stopped.id });
    const [codexLaunch] = await launchesOf(agents, "codex", 1);
    await expect
      .poll(async () => (await sessionsOf(api)).find((s) => s.id === codex.id)?.agentSessionId, {
        timeout: 10_000,
      })
      .toBe(codexLaunch!.rolloutId);
    const before = await sessionsOf(api);

    await server.restart();
    // Restores run one at a time through the session queue, and OpenCode's now starts a server
    // first: wait until every running session has its terminal again before comparing.
    await expect
      .poll(
        async () =>
          (await sessionsOf(await server.rpc())).filter(
            (session) => session.state === "running" && session.terminalId === null,
          ).length,
        { timeout: RESTART_TIMEOUT_MS, message: "every restored session's terminal" },
      )
      .toBe(0);
    const restored = await sessionsOf(await server.rpc());

    expect(restored.map((session) => [session.id, session.state, session.agentSessionId])).toEqual(
      before.map((session) => [
        session.id,
        session.id === stopped.id ? "stopped" : "running",
        session.agentSessionId,
      ]),
    );
    const running = restored.filter((session) => session.state === "running");
    expect(running.map((session) => session.id)).toEqual(
      [shell, claude, pi, opencode, codex].map((s) => s.id),
    );
    const terminals = await (await server.rpc()).terminals.list();
    expect(
      terminals.map((terminal) => [terminal.id, terminal.sessionId, terminal.taskId, terminal.cwd]),
    ).toEqual(
      running.map((session) => [session.terminalId, session.id, task.id, task.workspacePath]),
    );
    expect(restored.find((session) => session.id === stopped.id)?.terminalId).toBeNull();
    expect(terminals[0]!.command).toBe("/bin/sh");
    expect(terminals[0]!.args).toEqual([]);

    // Five agents resume one after another; the test's own budget is the deadline, not the
    // helper's default 10 s, which a loaded machine can miss on the last of them.
    const claudeLaunches = await launchesOf(agents, "claude", 3, RESTART_TIMEOUT_MS);
    expect(claudeLaunches[2]!.argv).toEqual(["--resume", claude.agentSessionId]);
    expect((await launchesOf(agents, "pi", 2, RESTART_TIMEOUT_MS))[1]!.argv).toEqual([
      "--session-id",
      pi.agentSessionId,
    ]);
    // OpenCode's TUI is a client of the run's one server, started or resumed under Corral's id.
    expect((await tuiLaunchesOf(agents, "opencode", 2, RESTART_TIMEOUT_MS))[1]!.argv).toEqual([
      "--server",
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      "--session",
      opencode.agentSessionId,
    ]);
    expect(
      frontendArgs((await launchesOf(agents, "codex", 2, RESTART_TIMEOUT_MS))[1]!.argv),
    ).toEqual(["resume", codexLaunch!.rolloutId]);
  },
  RESTART_TIMEOUT_MS,
);

test("a Claude session that never got a prompt is restored under the same id, as a new conversation", async () => {
  const { api, task } = await addTask(server, "Silent");
  const session = await api.sessions.start({ taskId: task.id, kind: "claude", size: SIZE });
  await launchesOf(agents, "claude", 1);

  await server.restart();

  const launches = await launchesOf(agents, "claude", 2);
  expect(launches[1]!.argv).toEqual(["--session-id", session.agentSessionId]);
  const [restored] = await sessionsOf(await server.rpc());
  expect(restored).toMatchObject({ state: "running", agentSessionId: session.agentSessionId });
  const client = await server.attach(restored!.terminalId!);
  await client.waitForScreen("fake claude ready");
});

test("a restored agent gets the same CORRAL_* environment and works in its task's workspace", async () => {
  const { api, task } = await addTask(server, "Same env");
  const session = await api.sessions.start({ taskId: task.id, kind: "pi", size: SIZE });
  await launchesOf(agents, "pi", 1);

  await server.restart();

  const launches = await launchesOf(agents, "pi", 2);
  expect(launches[1]).toMatchObject({
    cwd: task.workspacePath,
    env: { CORRAL_SESSION_ID: session.id, CORRAL_TASK_ID: task.id },
  });
  const restored = (await sessionsOf(await server.rpc()))[0]!;
  const client = await server.attach(restored.terminalId!);
  await client.waitForScreen("fake pi ready");
});

test("a Codex session that had not shown its id by the restart cannot be resumed and is not started", async () => {
  vi.stubEnv("FAKE_CODEX_ROLLOUT", "never");
  const { api, task } = await addTask(server, "No id");
  const session = await api.sessions.start({ taskId: task.id, kind: "codex", size: SIZE });
  await launchesOf(agents, "codex", 1);

  await server.restart();

  expect(await sessionsOf(await server.rpc())).toEqual([
    { ...session, state: "unresumable", terminalId: null },
  ]);
  // One terminal frontend launch; the session's app-server is not a frontend.
  expect(await launchesOf(agents, "codex", 1)).toHaveLength(1);
});

test("a Codex rollout written just before the server stops is not lost", async () => {
  vi.stubEnv("FAKE_CODEX_ROLLOUT", "lazy");
  const { api, task } = await addTask(server, "Late id");
  const session = await api.sessions.start({ taskId: task.id, kind: "codex", size: SIZE });
  const client = await server.attach(session.terminalId!);
  await client.waitForScreen("fake codex ready");
  const [launch] = await launchesOf(agents, "codex", 1);
  client.type("hello\n");
  await client.waitForScreen("fake codex got: hello");

  await server.restart();

  const restored = (await sessionsOf(await server.rpc()))[0]!;
  expect(restored).toMatchObject({ state: "running", agentSessionId: launch!.rolloutId });
  expect(frontendArgs((await launchesOf(agents, "codex", 2))[1]!.argv)).toEqual([
    "resume",
    launch!.rolloutId,
  ]);
});

test("a session that cannot start on restore becomes stopped, the others still start, and the server comes up", async () => {
  const { api, task } = await addTask(server, "Half");
  const claude = await api.sessions.start({ taskId: task.id, kind: "claude", size: SIZE });
  const pi = await api.sessions.start({ taskId: task.id, kind: "pi", size: SIZE });
  await launchesOf(agents, "pi", 1);
  // `claude` disappears from PATH; `pi` stays.
  const bin = await mkdtemp(join(tmpdir(), "corral-partial-path-"));
  await writeFile(join(bin, "pi"), `#!/bin/sh\nexec ${join(FAKE_BIN, "pi")} "$@"\n`, {
    mode: 0o755,
  });
  vi.stubEnv("PATH", `${bin}${delimiter}${dirname(process.execPath)}`);
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

  await server.restart();

  const restored = await sessionsOf(await server.rpc());
  expect(restored.map((session) => [session.id, session.state])).toEqual([
    [claude.id, "stopped"],
    [pi.id, "running"],
  ]);
  expect(log).toHaveBeenCalledWith(expect.stringContaining(claude.id), expect.any(String));
  await rm(bin, { recursive: true, force: true });
});
