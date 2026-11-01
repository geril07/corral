import { defaultClientConfig } from "@corral/protocol/config";
import { Project, Task } from "@corral/protocol/rpc";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { ChatService } from "../chat/chat-service.ts";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { launchesOf } from "../../test/session-helpers.ts";
import { ProjectStore } from "../projects/project-store.ts";
import { TaskStore } from "../tasks/task-store.ts";
import { OpenCodeServers } from "../chat/opencode-server.ts";
import { OpenCodeIntegration } from "../status/opencode-integration.ts";
import { openDatabase } from "../storage/database.ts";
import { TerminalRegistry } from "../terminals/terminal-registry.ts";
import { SessionService } from "./session-service.ts";
import { SessionStore } from "./session-store.ts";

const SIZE = { cols: 80, rows: 24 };
const TASK_ID = "task-1";
const PROMPT = `-restore the "old" table\nand say why`;

// The service, its SQLite file, its PTYs, the fake agents and the temp directories are real; only
// the agent CLIs are fakes, which log the argv they were launched with.
const agents = useFakeAgents();
let root: string;
let dataDir: string;
let database: DatabaseSync;
let terminals: TerminalRegistry;
let sessions: SessionService;

function openServer(): void {
  database = openDatabase(dataDir);
  terminals = new TerminalRegistry();
  sessions = new SessionService({
    store: new SessionStore(database),
    tasks: new TaskStore(database),
    terminals,
    chat: new ChatService({ dataDir }),
    statusUrl: (sessionId) => `http://127.0.0.1:9${sessionId}/report`,
    openCode: OpenCodeIntegration.install(dataDir),
    openCodeServers: new OpenCodeServers({ dataDir }),
    // A start and a resume read no profile; a config without profiles makes asking for one
    // fail loudly. The launch reads `[agents]` for the command, which is the empty defaults.
    config: {
      state: () => ({
        path: "",
        config: defaultClientConfig(""),
        profiles: [],
        agents: [],
        problems: [],
      }),
    },
    // Removing a session is not what this test is about; the tasks feed is elsewhere.
    taskEvents: { primarySessionRemoved: () => undefined },
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "corral-prompt-"));
  dataDir = join(root, "data");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  openServer();
  const project = Project.parse({
    id: "project-1",
    name: "app",
    path: workspace,
    defaultBaseBranch: "main",
  });
  new ProjectStore(database).insert(project);
  new TaskStore(database).insert(
    Task.parse({
      id: TASK_ID,
      projectId: project.id,
      title: "Prompt",
      titleSource: "user",
      prompt: null,
      primarySessionId: null,
      branch: "main",
      workspacePath: workspace,
      ownsWorktree: false,
      state: "active",
      seenAt: null,
      createdAt: Date.now(),
    }),
  );
});

afterEach(async () => {
  await sessions.shutDown();
  await terminals.closeAll();
  database.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

test("the prompt is the first start's argument, and a restart, a settle-and-continue or a server restore never passes it again", async () => {
  // Claude Code has a transcript as soon as it starts, so every later launch resumes the conversation.
  vi.stubEnv("FAKE_CLAUDE_TRANSCRIPT", "eager");
  const session = await sessions.start(TASK_ID, "claude", SIZE, { prompt: PROMPT });
  const id = session.agentSessionId!;
  expect((await launchesOf(agents, "claude", 1))[0]!.argv).toEqual([
    "--session-id",
    id,
    ` ${PROMPT}`,
  ]);

  // The caller may offer the prompt again; a resume has a conversation, so it is dropped.
  await sessions.stop(session.id);
  await sessions.restart(session.id, SIZE, { prompt: PROMPT });
  expect((await launchesOf(agents, "claude", 2))[1]!.argv).toEqual(["--resume", id]);

  await sessions.suspendAllIn(TASK_ID);
  await sessions.resumeAllIn(TASK_ID);
  expect((await launchesOf(agents, "claude", 3))[2]!.argv).toEqual(["--resume", id]);

  // A server restart: a new process on the same data directory, which restores the running session.
  await sessions.shutDown();
  await terminals.closeAll();
  database.close();
  openServer();
  sessions.restore();
  expect((await launchesOf(agents, "claude", 4))[3]!.argv).toEqual(["--resume", id]);
});

test("a Claude session that never wrote its transcript starts a new conversation on restart, with the prompt the caller offers", async () => {
  const session = await sessions.start(TASK_ID, "claude", SIZE, { prompt: PROMPT });
  const id = session.agentSessionId;
  expect((await launchesOf(agents, "claude", 1))[0]!.argv).toEqual([
    "--session-id",
    id,
    ` ${PROMPT}`,
  ]);

  // The fake never wrote a transcript, so `hasConversation` is false and the start flags come back.
  await sessions.stop(session.id);
  await sessions.restart(session.id, SIZE);
  expect((await launchesOf(agents, "claude", 2))[1]!.argv).toEqual(["--session-id", id]);

  // Nothing stored the prompt: a fallback start carries it only when the caller brings it.
  await sessions.stop(session.id);
  await sessions.restart(session.id, SIZE, { prompt: "-run the tests first" });
  expect((await launchesOf(agents, "claude", 3))[2]!.argv).toEqual([
    "--session-id",
    id,
    " -run the tests first",
  ]);
});

test("a shell session rejects a prompt instead of dropping it", async () => {
  vi.stubEnv("SHELL", "/bin/sh");
  await expect(sessions.start(TASK_ID, "shell", SIZE, { prompt: PROMPT })).rejects.toThrow(
    "a shell session takes no prompt",
  );
  expect(sessions.list()).toEqual([]);

  const shell = await sessions.start(TASK_ID, "shell", SIZE);
  await sessions.stop(shell.id);
  await expect(sessions.restart(shell.id, SIZE, { prompt: PROMPT })).rejects.toThrow(
    "a shell session takes no prompt",
  );
  expect(sessions.list().map((stored) => stored.state)).toEqual(["stopped"]);
  expect(await agents.launches()).toEqual([]);
});
