import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { useFakeAgents } from "../../test/fake-agents.ts";
import { processExists } from "../../test/session-helpers.ts";
import { ChatLaunchError } from "./chat-errors.ts";
import { ChatService, type ChatLaunchRequest } from "./chat-service.ts";

const agents = useFakeAgents();
let root: string;
let service: ChatService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "corral-chat-service-"));
  service = new ChatService({
    dataDir: root,
    timeouts: { readyTimeoutMs: 2000, exitGraceMs: 500, writerWaitMs: 1000, dialogTimeoutMs: 1000 },
  });
});

afterEach(async () => {
  await service.closeAll();
  await rm(root, { recursive: true, force: true });
});

function launchRequest(sessionId: string): ChatLaunchRequest {
  return {
    sessionId,
    command: "pi",
    args: ["--mode", "rpc", "--session-id", "service-contract"],
    cwd: root,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    prompt: null,
    onStatus: () => undefined,
    onExit: () => undefined,
  };
}

test("two concurrent launches of one session id spawn exactly one child and refuse the other", async () => {
  const results = await Promise.allSettled([
    service.launch(launchRequest("session-1")),
    service.launch(launchRequest("session-1")),
  ]);

  const refused = results.filter((result) => result.status === "rejected");
  expect(refused).toHaveLength(1);
  expect(refused[0]).toMatchObject({ reason: expect.any(ChatLaunchError) });
  // The refusal happened before the loser could spawn: one launch was logged, not two.
  await expect
    .poll(async () => (await agents.launches()).length, {
      timeout: 10_000,
      message: "the launches",
    })
    .toBe(1);
  const [launch] = await agents.launches();
  expect(processExists(launch!.pid)).toBe(true);

  await service.closeAll();

  await expect
    .poll(async () => processExists(launch!.pid), { timeout: 10_000, message: "the stopped child" })
    .toBe(false);
});

test("a stop that arrives while the launch is in flight waits for it and stops the child", async () => {
  const launching = service.launch(launchRequest("session-2"));
  const stopping = service.stop("session-2");
  await Promise.all([launching, stopping]);

  const [launch] = await agents.launches();
  expect(launch).toBeDefined();
  await expect
    .poll(async () => processExists(launch!.pid), { timeout: 10_000, message: "the stopped child" })
    .toBe(false);
});
