import type { CorralClient } from "@corral/client/corral-client";
import { expect, test, afterEach, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { agentLaunches, setServerEnv } from "../../../test/fake-agents.ts";
import {
  prefixShifted,
  prefixThen,
  realServerClients,
  screenText,
} from "../../../test/real-client.ts";
import { App } from "../../../test/render-app.tsx";
import {
  appWithProject,
  openAgentSessionPicker,
  createTaskWithShell,
  focusedIsTerminal,
  sessionTabs,
  shellTabs,
  workspace,
} from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();

/** The screen with wrapped lines joined: the test viewport is narrow. */
const wrappedScreen = () => screenText().replaceAll("\n", "");
const picker = () => page.getByRole("dialog", { name: "New agent session" });
const removeDialog = () => page.getByRole("alertdialog");
/** A session tab: `claude`, or `claude stopped` once it is not running. */
const sessionButton = (kind: string, state?: string) =>
  sessionTabs().getByRole("tab", { name: state ? `${kind} ${state}` : new RegExp(`^${kind}$`) });
const stoppedPane = () => page.getByRole("region", { name: "stopped session" });
const exitedNotice = () => page.getByRole("status", { name: "terminal exited" });

const restoredEnv: [string, string | null][] = [];
/** Changes the server's environment for this test; undone afterwards. */
async function withServerEnv(name: string, value: string | null) {
  restoredEnv.push([name, await setServerEnv(name, value)]);
}
afterEach(async () => {
  for (const [name, value] of restoredEnv.splice(0).toReversed()) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- restored in reverse order
    await setServerEnv(name, value);
  }
});

function sessionOf(client: CorralClient, kind: string) {
  const session = client.sessions.getSnapshot().sessions.find((each) => each.kind === kind);
  if (!session) throw new Error(`no ${kind} session`);
  return session;
}

/** The argument lists the fake agent was launched with for this session. */
async function argvOf(sessionId: string) {
  return (await agentLaunches())
    .filter((launch) => launch.env.CORRAL_SESSION_ID === sessionId)
    .map((launch) => launch.argv);
}

/** Starts an agent from the keyboard and waits for the fake to print its banner. */
async function startAgent(kind: string, keys: string) {
  await openAgentSessionPicker("terminal");
  await expect.element(picker().getByRole("radio", { name: "claude" })).toHaveFocus();
  await userEvent.keyboard(keys);
  await expect.element(picker()).not.toBeInTheDocument();
  await expect.element(sessionButton(kind)).toHaveAttribute("aria-selected", "true");
  await expect.poll(wrappedScreen).toContain(`fake ${kind} ready`);
}

test("prefix s opens the picker; a digit starts that agent in the task and the keyboard goes to it", async () => {
  const { client } = await appWithProject(newClient());
  await createTaskWithShell("Agents");
  const task = client.tasks.getSnapshot().tasks[0]!;

  await startAgent("claude", "1");

  const session = sessionOf(client, "claude");
  expect(session).toMatchObject({ taskId: task.id, state: "running" });
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await userEvent.keyboard("hi-there{Enter}");
  await expect.poll(wrappedScreen).toContain("fake claude got: hi-there");
  const launch = (await agentLaunches()).find((each) => each.env.CORRAL_SESSION_ID === session.id);
  expect(launch).toMatchObject({
    argv: ["--session-id", session.agentSessionId],
    cwd: task.workspacePath,
  });
});

test("arrows and Enter pick an agent in the picker too", async () => {
  const { client } = await appWithProject(newClient());
  await createTaskWithShell("Agents");

  await startAgent("codex", "{ArrowDown}{Enter}");

  expect(sessionOf(client, "codex").state).toBe("running");
});

test("prefix x stops the session, which stays in the list; prefix r starts it again resuming the conversation", async () => {
  const { client } = await appWithProject(newClient());
  await createTaskWithShell("Agents");
  await startAgent("claude", "1");
  await userEvent.keyboard("remember-me{Enter}");
  await expect.poll(wrappedScreen).toContain("fake claude got: remember-me");
  const { id, agentSessionId } = sessionOf(client, "claude");

  await prefixThen("x");
  await expect.element(sessionButton("claude", "stopped")).toHaveAttribute("aria-selected", "true");
  await expect.element(stoppedPane()).toMatchTextContent("resumes");
  await expect.element(stoppedPane()).toMatchTextContent("Enter, or alt+a r.");
  await sessionButton("claude", "stopped").click({ button: "right" });
  await expect.element(page.getByRole("menuitem", { name: "Restart claude" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  expect(sessionOf(client, "claude")).toMatchObject({ state: "stopped", terminalId: null });

  await prefixThen("r");
  await expect.element(sessionButton("claude")).toHaveAttribute("aria-selected", "true");
  await expect.poll(screenText).toContain("fake claude ready");
  await vi.waitFor(async () =>
    expect(await argvOf(id)).toEqual([
      ["--session-id", agentSessionId],
      ["--resume", agentSessionId],
    ]),
  );
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
});

test("prefix d settles the task, stopping its agent, and unsettling resumes the conversation", async () => {
  const { client } = await appWithProject(newClient());
  await createTaskWithShell("Agents");
  await startAgent("claude", "1");
  await userEvent.keyboard("remember-me{Enter}");
  await expect.poll(wrappedScreen).toContain("fake claude got: remember-me");
  const { id, agentSessionId } = sessionOf(client, "claude");

  await prefixThen("d");
  await expect.element(workspace().getByRole("button", { name: "Settled (1)" })).toBeVisible();
  await expect.element(sessionButton("claude", "stopped")).toBeVisible();
  expect(sessionOf(client, "claude")).toMatchObject({ state: "stopped", terminalId: null });

  await prefixThen("d");
  await expect.element(sessionButton("claude")).toBeVisible();
  await vi.waitFor(() => expect(sessionOf(client, "claude").state).toBe("running"));
  await vi.waitFor(async () =>
    expect(await argvOf(id)).toEqual([
      ["--session-id", agentSessionId],
      ["--resume", agentSessionId],
    ]),
  );
});

test("Enter on the stopped session's pane starts it again", async () => {
  const { client } = await appWithProject(newClient());
  await createTaskWithShell("Agents");
  await startAgent("pi", "3");
  await prefixThen("x");
  await expect.element(stoppedPane().getByRole("button", { name: "Start again" })).toHaveFocus();

  await userEvent.keyboard("{Enter}");

  await expect.element(sessionButton("pi")).toHaveAttribute("aria-selected", "true");
  await expect.poll(screenText).toContain("fake pi ready");
  expect(sessionOf(client, "pi").state).toBe("running");
});

test("an agent that ends by itself shows its last screen and is stopped until prefix r", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Agents");
  await startAgent("opencode", "4");

  await userEvent.keyboard("exit{Enter}");

  await expect.element(sessionButton("opencode", "stopped")).toBeVisible();
  await expect.element(exitedNotice()).toMatchTextContent("alt+a r");
  expect(wrappedScreen()).toContain("fake opencode ready");

  await prefixThen("r");
  await expect.element(sessionButton("opencode")).toBeVisible();
  await expect.element(exitedNotice()).not.toBeInTheDocument();
});

test("a Codex session whose conversation was never identified is unresumable and says it starts a new one", async () => {
  await withServerEnv("FAKE_CODEX_ROLLOUT", "never");
  await appWithProject(newClient());
  await createTaskWithShell("Agents");
  await startAgent("codex", "2");

  await userEvent.keyboard("exit{Enter}");

  await expect.element(sessionButton("codex", "unresumable")).toBeVisible();
  await expect.element(exitedNotice()).toMatchTextContent("will start a new conversation");
});

test("an agent missing from the server's PATH keeps the picker open with the reason", async () => {
  const { client } = await appWithProject(newClient());
  await createTaskWithShell("Agents");
  await withServerEnv("PATH", "/nonexistent");

  await prefixThen("s");
  await expect.element(picker().getByRole("radio", { name: "claude" })).toHaveFocus();
  await userEvent.keyboard("1");

  await expect
    .element(picker().getByRole("alert"))
    .toMatchTextContent("claude was not found on the server's PATH.");
  await expect.element(picker()).toBeVisible();
  expect(client.sessions.getSnapshot().sessions.filter((each) => each.kind === "claude")).toEqual(
    [],
  );

  await userEvent.keyboard("{Escape}");
  await expect.element(picker()).not.toBeInTheDocument();
  await expect.element(shellTabs()).toHaveLength(1);
});

test("prefix s without a task says so instead of opening the picker", async () => {
  await render(<App client={newClient()} />);

  await prefixThen("s");

  await expect
    .element(page.getByRole("status").filter({ hasText: "Select a task" }))
    .toMatchTextContent("Select a task");
  await expect.element(picker()).not.toBeInTheDocument();
});

test("prefix n and p cycle through the task's shells and agents", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Agents");
  await startAgent("claude", "1");

  await prefixThen("n");
  await expect.element(shellTabs().first()).toHaveAttribute("aria-selected", "true");
  await prefixThen("p");
  await expect.element(sessionButton("claude")).toHaveAttribute("aria-selected", "true");
  await prefixThen("c");
  await expect.element(shellTabs()).toHaveLength(2);
  await prefixThen("p");
  await expect.element(sessionButton("claude")).toHaveAttribute("aria-selected", "true");
  await expect.poll(screenText).toContain("fake claude ready");
});

test("prefix shift+x asks first, starts on Cancel, and removes the session for good", async () => {
  const { client } = await appWithProject(newClient());
  await createTaskWithShell("Agents");
  await startAgent("claude", "1");

  await prefixShifted("x");
  await expect.element(removeDialog().getByRole("button", { name: "Cancel" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(removeDialog()).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  expect(client.sessions.getSnapshot().sessions).toHaveLength(2);

  await prefixShifted("x");
  await expect.element(removeDialog().getByRole("button", { name: "Cancel" })).toHaveFocus();
  await userEvent.keyboard("{Tab}{Enter}");

  await expect.element(removeDialog()).not.toBeInTheDocument();
  await expect.element(sessionButton("claude")).not.toBeInTheDocument();
  expect(client.sessions.getSnapshot().sessions.map((session) => session.kind)).toEqual(["shell"]);
  await expect.element(shellTabs()).toHaveAttribute("aria-selected", "true");
});

test("prefix x on a loose terminal closes it; r and shift+x leave it alone", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await prefixThen("c");
  await expect.element(workspace().getByRole("button", { name: /^sh · / })).toBeVisible();

  await prefixThen("r");
  await prefixShifted("x");
  await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
  await expect.element(workspace().getByRole("button", { name: /^sh · / })).toBeVisible();

  await prefixThen("x");
  await expect.element(workspace().getByRole("button", { name: /^sh · / })).not.toBeInTheDocument();
});
