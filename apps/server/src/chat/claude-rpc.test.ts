import { beforeEach, expect, test } from "vite-plus/test";
import type { ChatSendMode } from "@corral/protocol/rpc";
import { agentStatus } from "./chat-errors.ts";
import type { ChatDriver, ChatDriverRegistration, ChatDriverStart } from "./chat-driver.ts";
import type { ChatTimeline } from "./timeline.ts";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { addProject } from "../../test/project-fixture.ts";
import { useServer } from "../../test/server-fixture.ts";
import { sessionsOf } from "../../test/session-helpers.ts";
import { writeClaudeTranscript } from "../../test/claude-transcripts.ts";

const SIZE = { cols: 80, rows: 24 };

/** What the session service asked the chat frontend to open, in launch order. */
const launches: { how: string; agentSessionId: string | null }[] = [];

/**
 * A chat driver that only records its launch. The session service's wiring — which `how` a chat
 * launch gets — is what this file pins; the real driver's behaviour with that `how` is covered by
 * `claude-driver.test.ts`.
 */
class RecordingChatDriver implements ChatDriver {
  readonly timeline: ChatTimeline;
  readonly #request: ChatDriverStart;
  #closed = false;

  constructor(request: ChatDriverStart) {
    this.#request = request;
    this.timeline = request.timeline;
    this.#request.onStatus(agentStatus("idle", Date.now()));
  }

  get closed(): boolean {
    return this.#closed;
  }

  get sessionId(): string {
    return this.#request.sessionId;
  }

  get state() {
    return this.timeline.state;
  }

  start(): void {
    // Nothing to start: the launch is the observation.
  }

  async stop(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.timeline.close();
    this.#request.onExit(null);
  }

  send(_text: string, _mode: ChatSendMode): string {
    return "recording-driver-item";
  }

  async abort(): Promise<void> {}

  respond(): void {}

  async setModel(): Promise<void> {}

  async setReasoning(): Promise<void> {}
}

const recordingClaude: ChatDriverRegistration = {
  capabilities: {
    steer: false,
    followUp: false,
    approvals: true,
    modelSwitch: false,
    reasoningLevels: false,
    terminalView: "handoff-only",
  },
  args: () => [],
  create: (launch) => {
    launches.push({ how: launch.how, agentSessionId: launch.agentSessionId });
    return new RecordingChatDriver(launch);
  },
};

const server = useServer({
  chat: {
    drivers: { claude: recordingClaude },
    dialogTimeoutMs: 1000,
    readyTimeoutMs: 2000,
    exitGraceMs: 400,
    writerWaitMs: 2000,
  },
});
const agents = useFakeAgents();

beforeEach(() => {
  launches.length = 0;
});

/**
 * A task whose primary Claude session runs in the terminal with no prompt. Its id exists but no
 * transcript does — the exact shape the P1 review reproduced.
 */
async function terminalClaudeTask() {
  const { project } = await addProject(server);
  const api = await server.rpc();
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Resume wiring",
    agent: { kind: "claude", view: "terminal" },
    workspace: { type: "main-worktree" },
  });
  const session = (await sessionsOf(api)).find((each) => each.id === task.primarySessionId)!;
  const terminal = await server.attach(session.terminalId!);
  await terminal.waitForScreen("fake claude ready");
  return { api, task, session };
}

test("a chat launch resumes only when the agent has a transcript, and the terminal leg agrees", async () => {
  const { api, task, session } = await terminalClaudeTask();

  // A `setView` into chat launches with `how: "resume"`. With no transcript the launch must become
  // a start under the same id, not an SDK resume of a missing conversation.
  const opened = await api.sessions.setView({ id: session.id, view: "chat", size: SIZE });
  expect(opened).toMatchObject({
    view: "chat",
    state: "running",
    agentSessionId: session.agentSessionId,
  });
  expect(launches).toEqual([{ how: "start", agentSessionId: session.agentSessionId }]);

  // Write the transcript the first prompt would have written; the same request is now a resume.
  writeClaudeTranscript(agents.claudeConfigDir, task.workspacePath, session.agentSessionId!);
  const back = await api.sessions.setView({ id: session.id, view: "terminal", size: SIZE });
  const resumed = await server.attach(back.terminalId!);
  await resumed.waitForScreen("fake claude ready");
  await api.sessions.setView({ id: session.id, view: "chat", size: SIZE });

  expect(launches).toEqual([
    { how: "start", agentSessionId: session.agentSessionId },
    { how: "resume", agentSessionId: session.agentSessionId },
  ]);
});
