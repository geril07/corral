import { expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  addProject,
  createRepo,
  openedWindow,
  promptField,
  screenText,
  sessionTab,
} from "./app-helpers.ts";
import { isAlive, readLaunches, readPiJournal, test } from "./fixtures.ts";

/** The value after `--session-id`, whatever else the launch carried. */
function sessionIdOf(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--session-id");
  return index < 0 ? undefined : argv[index + 1];
}

/** The `[tasks]` default agent, so the composer starts this task's agent as pi. */
function writeConfig(stateDir: string, text: string) {
  const directory = path.join(stateDir, "config");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "config.toml"), text);
}

/**
 * B4: `prefix v` hands one agent session between its two views. The session is started in the
 * terminal (the composer's own path), then moved to chat, back to the terminal while the agent is
 * waiting for an answer, and to chat again — always the same agent session id, so the conversation
 * survives and the terminal launch is a resume, not a new conversation.
 */
test("prefix v moves a session chat → terminal → chat on one agent session id", async ({
  launchApp,
  stateDir,
}) => {
  writeConfig(stateDir, '[tasks]\nagent = "pi"\n');
  const repo = createRepo(stateDir);
  const window = await openedWindow(await launchApp());
  await expect(window.getByText("Add a repository to start")).toBeVisible();
  await addProject(window, repo);

  // A task whose primary agent is pi, started in the terminal view with the prompt as its argv.
  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyT");
  await expect(promptField(window)).toBeFocused();
  await window.keyboard.type("Change the note");
  await window.keyboard.press("Enter");
  await expect(sessionTab(window, "pi")).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => screenText(window)).toContain("fake pi ready");

  const piLaunches = () => readLaunches(stateDir).filter((launch) => launch.agent === "pi");
  await expect.poll(() => piLaunches().length).toBe(1);
  const terminalStart = piLaunches()[0]!;
  // pi takes `--session-id` both ways, so the id it was started with is the conversation's id;
  // the prompt rides on this first start only.
  const agentSessionId = sessionIdOf(terminalStart.argv);
  if (agentSessionId === undefined) throw new Error("the fake pi ran without --session-id");
  expect(terminalStart.argv).toEqual(["--session-id", agentSessionId, "Change the note"]);
  expect(terminalStart.env.CORRAL_SESSION_ID).toEqual(expect.any(String));
  const sessionId = terminalStart.env.CORRAL_SESSION_ID;

  // terminal → chat: the chat's RPC child opens the same pi session, and the task's prompt is
  // handed over because pi's own history is still empty.
  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyV");
  const transcript = window.getByRole("log", { name: "Chat transcript" });
  await expect(transcript).toBeVisible();
  await expect.poll(() => screenText(window)).not.toContain("fake pi ready");
  await expect.poll(() => piLaunches().length).toBe(2);
  const rpcLaunch = piLaunches()[1]!;
  expect(rpcLaunch.argv).toEqual(["--mode", "rpc", "--session-id", agentSessionId]);
  expect(rpcLaunch.env.CORRAL_SESSION_ID).toEqual(sessionId);
  await expect(transcript.getByRole("article", { name: "Your message" })).toHaveText(
    "Change the note",
  );
  await expect(transcript.getByText("Here is the answer.")).toBeVisible();
  // The agent is waiting on its own confirm dialog: what a switch would cancel.
  const request = window.getByRole("region", { name: "Agent request" });
  await expect(request).toContainText("Apply the edit?");
  await expect(request).toContainText("notes.txt will change.");
  // The terminal's process is gone before the chat's exists.
  await expect.poll(() => isAlive(terminalStart.pid)).toBe(false);

  // chat → terminal while working: confirm first, then the abort and the switch.
  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyV");
  const confirm = window.getByRole("alertdialog");
  await expect(confirm.getByRole("button", { name: "Cancel" })).toBeFocused();
  await expect(confirm).toContainText("The agent is waiting for your answer.");
  await window.keyboard.press("Tab");
  await window.keyboard.press("Enter");
  await expect(confirm).toBeHidden();
  await expect.poll(() => screenText(window)).toContain("fake pi ready");
  await expect.poll(() => piLaunches().length).toBe(3);
  const terminalAgain = piLaunches()[2]!;
  expect(terminalAgain.argv).toEqual(["--session-id", agentSessionId]);
  expect(terminalAgain.env.CORRAL_SESSION_ID).toEqual(sessionId);
  await expect.poll(() => isAlive(rpcLaunch.pid)).toBe(false);

  // terminal → chat again: history comes back from pi's own session, and the prompt is not sent
  // a second time (one user message in the journal after four frontends).
  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyV");
  await expect(transcript).toBeVisible();
  await expect.poll(() => piLaunches().length).toBe(4);
  const backToChat = piLaunches()[3]!;
  expect(backToChat.argv).toEqual(["--mode", "rpc", "--session-id", agentSessionId]);
  expect(backToChat.env.CORRAL_SESSION_ID).toEqual(sessionId);
  // The conversation the first chat frontend wrote is rebuilt from pi's session, not resent.
  await expect(transcript.getByRole("article", { name: "Your message" })).toHaveText(
    "Change the note",
  );
  await expect(transcript.getByText("Here is the answer.")).toBeVisible();
  await expect.poll(() => isAlive(terminalAgain.pid)).toBe(false);

  // One agent session across four frontends, each dead before the next started.
  expect(new Set(piLaunches().map((launch) => launch.env.CORRAL_SESSION_ID))).toEqual(
    new Set([sessionId]),
  );
  expect(new Set(piLaunches().map((launch) => sessionIdOf(launch.argv)))).toEqual(
    new Set([agentSessionId]),
  );
  // Every handoff resumed that id and never handed the prompt over again.
  expect(
    piLaunches()
      .slice(1)
      .map((launch) => launch.argv),
  ).toEqual([
    ["--mode", "rpc", "--session-id", agentSessionId],
    ["--session-id", agentSessionId],
    ["--mode", "rpc", "--session-id", agentSessionId],
  ]);
  const journal = readPiJournal(stateDir, agentSessionId);
  expect(journal.filter((message) => message.role === "user")).toHaveLength(1);
  // The session kept its name and its place: one tab, still called `pi`, still selected.
  await expect(sessionTab(window, "pi")).toHaveAttribute("aria-selected", "true");
});
