import type { CorralClient } from "@corral/client/corral-client";
import type { Session } from "@corral/protocol/rpc";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { agentLaunches, setServerEnv } from "../../../test/fake-agents.ts";
import { createGitRepo } from "../../../test/git-repo.ts";
import { writeConfig } from "../../../test/config-command.ts";
import { prefixThen, realServerClients, screenText } from "../../../test/real-client.ts";
import { App } from "../../../test/render-app.tsx";
import {
  openAgentSessionPicker,
  appWithProject,
  sessionTabs,
  taskWithShell,
} from "../../../test/task-flows.tsx";
import { describeLaunchError } from "./launch-error.ts";

const { newClient } = realServerClients();

const picker = () => page.getByRole("dialog", { name: "New agent session" });
const setup = () => page.getByRole("dialog", { name: "Start agent session" });
const startSelected = () => setup().getByRole("button", { name: "Start session" }).click();
const stoppedPane = () => page.getByRole("region", { name: /^(?:stopped|failed) session$/ });

const PROFILES = `
[profiles.claude-gateway]
name = "Claude gateway"
agent = "claude"
model = "claude-sonnet-4-5"

[profiles.opencode-team]
name = "OpenCode team"
agent = "opencode"
`;

const ENV_PROFILE = `
[profiles.claude-env]
name = "Claude env"
agent = "claude"
model = "claude-sonnet-4-5"
env = [{ targetName = "ANTHROPIC_AUTH_TOKEN", fromEnv = "PROFILE_MISSING_TOKEN" }]
`;

const restoredEnv: [string, string | null][] = [];
async function withServerEnv(name: string, value: string | null) {
  restoredEnv.push([name, await setServerEnv(name, value)]);
}
afterEach(async () => {
  for (const [name, value] of restoredEnv.splice(0).toReversed()) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- restored in reverse order
    await setServerEnv(name, value);
  }
});

async function applyConfig(client: CorralClient, text: string, profiles: number) {
  await writeConfig(text);
  await vi.waitFor(() => expect(client.config.getSnapshot().profiles).toHaveLength(profiles));
}

function sessionOf(client: CorralClient, kind: Session["kind"]): Session {
  const session = client.sessions.getSnapshot().sessions.find((each) => each.kind === kind);
  if (!session) throw new Error(`no ${kind} session`);
  return session;
}

async function argvOf(sessionId: string) {
  return (await agentLaunches())
    .filter((launch) => launch.env.CORRAL_SESSION_ID === sessionId)
    .map((launch) => launch.argv);
}

async function startedAgent(client: CorralClient, kind: Session["kind"]): Promise<Session> {
  await vi.waitFor(() => expect(sessionOf(client, kind).state).toBe("running"));
  return sessionOf(client, kind);
}

test("a named profile's model reaches the fake CLI and stays on the session", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Profiled");
  await applyConfig(client, PROFILES, 2);

  await openAgentSessionPicker("terminal");
  await expect.element(picker()).toBeVisible();
  await picker().getByRole("radio", { name: "Claude gateway" }).click();
  await userEvent.keyboard("{Enter}");
  await startSelected();

  await expect.element(picker()).not.toBeInTheDocument();
  const session = await startedAgent(client, "claude");
  expect(session.launch).toMatchObject({
    kind: "claude",
    profile: { id: "claude-gateway", name: "Claude gateway" },
    model: "claude-sonnet-4-5",
    provider: null,
  });
  await expect
    .poll(() => argvOf(session.id))
    .toEqual([["--model", "claude-sonnet-4-5", "--session-id", session.agentSessionId]]);
  await expect.poll(screenText).toContain("fake claude ready");

  // The tab names the agent; the launch snapshot above carries the profile and model.
  const tab = sessionTabs().getByRole("tab", { name: /^claude/ });
  await expect.element(tab).toBeVisible();

  // Stop, then change the profile in the file: the conversation keeps its snapshot.
  await prefixThen("x");
  await expect.element(stoppedPane()).not.toMatchTextContent("Claude gateway · claude-sonnet-4-5");
  await expect.element(stoppedPane().getByRole("button", { name: "Restart" })).toBeVisible();

  await applyConfig(
    client,
    `
[profiles.claude-gateway]
name = "Renamed gateway"
agent = "claude"
model = "claude-haiku-4"
`,
    1,
  );
  await expect.element(stoppedPane()).not.toMatchTextContent("Claude gateway · claude-sonnet-4-5");
  await expect.element(stoppedPane()).not.toMatchTextContent("claude-haiku-4");
  expect(sessionOf(client, "claude").launch).toMatchObject({
    profile: { name: "Claude gateway" },
    model: "claude-sonnet-4-5",
  });
});

test("a native-default start carries no profile or model and never borrows the file's model", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Native");
  await applyConfig(client, PROFILES, 2);

  await openAgentSessionPicker("terminal");
  await picker().getByRole("radio", { name: "claude" }).click();
  await userEvent.keyboard("{Enter}");
  await startSelected();

  const session = await startedAgent(client, "claude");
  expect(session.launch).toBeNull();
  await expect.poll(() => argvOf(session.id)).toEqual([["--session-id", session.agentSessionId]]);

  await prefixThen("x");
  await expect.element(stoppedPane()).not.toMatchTextContent("agent default model");
  await expect.element(stoppedPane().getByRole("button", { name: "Restart" })).toBeVisible();
  await expect.element(stoppedPane()).not.toMatchTextContent("claude-sonnet-4-5");
});

test("a missing environment reference keeps the picker draft and says which variable is missing", async () => {
  await withServerEnv("PROFILE_MISSING_TOKEN", null);
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Env");
  await applyConfig(client, ENV_PROFILE, 1);
  const shells = client.sessions.getSnapshot().sessions.length;

  await openAgentSessionPicker("terminal");
  await picker().getByRole("radio", { name: "Claude env" }).click();
  await userEvent.keyboard("{Enter}");
  await startSelected();

  await expect
    .element(setup().getByRole("alert"))
    .toMatchTextContent("no environment variable PROFILE_MISSING_TOKEN");
  await expect.element(setup().getByRole("button", { name: /Agent Claude env/ })).toBeVisible();
  expect(client.sessions.getSnapshot().sessions).toHaveLength(shells);

  // With the reference present, the same open picker completes the launch.
  await withServerEnv("PROFILE_MISSING_TOKEN", "not-a-real-token");
  await startSelected();
  await expect.element(picker()).not.toBeInTheDocument();
  const session = await startedAgent(client, "claude");
  expect(session.launch).toMatchObject({ profile: { id: "claude-env" } });
});

test("a profile removed from the live config cannot fall back to a native launch", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Live config");
  await applyConfig(client, PROFILES, 2);

  await openAgentSessionPicker("terminal");
  await picker().getByRole("radio", { name: "Claude gateway" }).click();
  await applyConfig(
    client,
    '[profiles.codex-work]\nname = "Codex work"\nagent = "codex"\nmodel = "gpt-5-codex"\n',
    1,
  );

  await expect
    .element(picker().getByRole("alert"))
    .toMatchTextContent("no longer in the config file");
  const start = picker().getByRole("option").last();
  await expect.element(start).toBeDisabled();
  const before = client.sessions.getSnapshot().sessions.length;

  // Enter from the stale selection must not submit the first native choice.
  picker().getByRole("radio", { name: "claude" }).element().focus();
  await userEvent.keyboard("{Enter}");
  expect(client.sessions.getSnapshot().sessions).toHaveLength(before);
  expect(
    client.sessions.getSnapshot().sessions.filter((session) => session.kind === "claude"),
  ).toHaveLength(0);

  // Recovery needs an explicit reselect; the stale draft is not silently replaced.
  await picker().getByRole("radio", { name: "Codex work" }).click();
  await expect.element(start).toBeEnabled();
  await start.click();
  await expect.element(picker()).not.toBeInTheDocument();
  await startSelected();
  const session = await startedAgent(client, "codex");
  expect(session.launch).toMatchObject({ profile: { id: "codex-work" } });
});

test("a profile revision change requires explicit reselect and launches the new choice", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Revision");
  await applyConfig(client, PROFILES, 2);

  await openAgentSessionPicker("terminal");
  await picker().getByRole("radio", { name: "Claude gateway" }).click();
  const before = client.config
    .getSnapshot()
    .profiles.find((profile) => profile.id === "claude-gateway")?.revision;

  await applyConfig(
    client,
    '[profiles.claude-gateway]\nname = "Claude gateway"\nagent = "claude"\nmodel = "claude-haiku-4"\n',
    1,
  );
  await vi.waitFor(() =>
    expect(
      client.config.getSnapshot().profiles.find((profile) => profile.id === "claude-gateway")
        ?.revision,
    ).not.toBe(before),
  );

  await expect
    .element(picker().getByRole("alert"))
    .toMatchTextContent(
      'The profile "Claude gateway" changed on the server. Review it and choose it again.',
    );
  const start = picker().getByRole("option").last();
  await expect.element(start).toBeDisabled();
  const beforeCount = client.sessions.getSnapshot().sessions.length;
  picker().getByRole("radio", { name: "claude" }).element().focus();
  await userEvent.keyboard("{Enter}");
  expect(client.sessions.getSnapshot().sessions).toHaveLength(beforeCount);

  await picker().getByRole("radio", { name: "Claude gateway" }).click();
  await expect.element(start).toBeEnabled();
  await start.click();
  await startSelected();

  const session = await startedAgent(client, "claude");
  expect(session.launch).toMatchObject({
    profile: { id: "claude-gateway" },
    model: "claude-haiku-4",
  });
  await expect
    .poll(() => argvOf(session.id))
    .toEqual([["--model", "claude-haiku-4", "--session-id", session.agentSessionId]]);
});

test("a revision pinned before a config edit is refused by the real RPC with no session", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Revision race");
  await applyConfig(client, PROFILES, 2);
  const task = client.tasks.getSnapshot().tasks[0]!;
  const revisionA = client.config
    .getSnapshot()
    .profiles.find((profile) => profile.id === "claude-gateway")?.revision;
  const before = client.sessions.getSnapshot().sessions.length;

  await applyConfig(
    client,
    '[profiles.claude-gateway]\nname = "Claude gateway"\nagent = "claude"\nmodel = "claude-haiku-4"\n',
    1,
  );
  const revisionB = client.config
    .getSnapshot()
    .profiles.find((profile) => profile.id === "claude-gateway")?.revision;
  expect(revisionB).not.toBe(revisionA);

  const error: unknown = await client.connection.api.sessions
    .start({
      taskId: task.id,
      kind: "claude",
      size: { cols: 80, rows: 24 },
      profileId: "claude-gateway",
      expectedProfileRevision: revisionA!,
    })
    .catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: "LAUNCH_PROFILE_CHANGED", data: { id: "claude-gateway" } });
  expect(describeLaunchError(error)).toContain("changed on the server");
  expect(
    (await agentLaunches()).filter((launch) => launch.env.CORRAL_TASK_ID === task.id),
  ).toHaveLength(0);
  expect(client.sessions.getSnapshot().sessions).toHaveLength(before);
  expect(
    client.sessions.getSnapshot().sessions.filter((session) => session.kind === "claude"),
  ).toHaveLength(0);

  const session = await client.connection.api.sessions.start({
    taskId: task.id,
    kind: "claude",
    size: { cols: 80, rows: 24 },
    profileId: "claude-gateway",
    expectedProfileRevision: revisionB,
  });
  expect(session.launch).toMatchObject({
    profile: { id: "claude-gateway" },
    model: "claude-haiku-4",
  });
  await expect
    .poll(() => argvOf(session.id))
    .toEqual([["--model", "claude-haiku-4", "--session-id", session.agentSessionId]]);
});

test("a client that connects after a failed restart sees the safe launchError on the stopped session", async () => {
  await withServerEnv("PROFILE_MISSING_TOKEN", "not-a-real-token");
  const first = newClient();
  const firstApp = await render(<App client={first} />);
  await vi.waitFor(() => expect(first.projects.getSnapshot().loaded).toBe(true));

  const repo = await createGitRepo("late-profile");
  const project = await first.connection.api.projects.add({ path: repo });
  const task = await first.connection.api.tasks.create({
    projectId: project.id,
    title: "Late",
    workspace: { type: "main-worktree" },
  });
  await applyConfig(first, ENV_PROFILE, 1);
  const session = await first.connection.api.sessions.start({
    taskId: task.id,
    kind: "claude",
    size: { cols: 80, rows: 24 },
    profileId: "claude-env",
  });
  await vi.waitFor(() => expect(sessionOf(first, "claude").state).toBe("running"));

  await first.connection.api.sessions.stop({ id: session.id });
  await withServerEnv("PROFILE_MISSING_TOKEN", null);
  const error: unknown = await first.connection.api.sessions
    .restart({ id: session.id, size: { cols: 80, rows: 24 } })
    .catch((thrown: unknown) => thrown);
  expect(error).toMatchObject({ code: "LAUNCH_ENV_MISSING" });
  expect(describeLaunchError(error)).toContain("no environment variable PROFILE_MISSING_TOKEN");
  await firstApp.unmount();

  const late = newClient();
  await render(
    <App
      client={late}
      initialEntries={[`/?project=${project.id}&task=${task.id}&entry=${session.id}`]}
    />,
  );
  await expect.element(stoppedPane()).toBeVisible();
  await expect
    .element(stoppedPane().getByRole("alert"))
    .toMatchTextContent("no environment variable PROFILE_MISSING_TOKEN");
  await expect.element(stoppedPane().getByRole("alert")).toMatchTextContent("Last start failed");
  expect(sessionOf(late, "claude").launchError).toContain("PROFILE_MISSING_TOKEN");
});

test("OpenCode's missing model capability is refused by the server, not simulated in the UI", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await vi.waitFor(() => expect(client.projects.getSnapshot().loaded).toBe(true));

  const repo = await createGitRepo("opencode-model");
  const project = await client.connection.api.projects.add({ path: repo });
  const task = await client.connection.api.tasks.create({
    projectId: project.id,
    title: "No model",
    workspace: { type: "main-worktree" },
  });
  const error: unknown = await client.connection.api.sessions
    .start({
      taskId: task.id,
      kind: "opencode",
      size: { cols: 80, rows: 24 },
      model: "gpt-5-codex",
    })
    .catch((thrown: unknown) => thrown);

  expect(error).toMatchObject({ code: "LAUNCH_MODEL_UNSUPPORTED" });
  expect(describeLaunchError(error)).toBe("opencode has no model choice at launch.");
});

test("the live picker follows model-specific thinking and refuses another agent", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Shared picker");
  await applyConfig(
    client,
    '[profiles.pi-work]\nname = "pi work"\nagent = "pi"\nmodel = "stub-1"\n',
    1,
  );
  const countBefore = client.sessions.getSnapshot().sessions.length;
  await openAgentSessionPicker("chat");
  await picker().getByRole("radio", { name: "pi", exact: true }).click();
  await picker().getByRole("option").first().click();
  expect(client.sessions.getSnapshot().sessions).toHaveLength(countBefore);
  await expect.element(picker()).not.toBeInTheDocument();
  await startSelected();
  await expect.element(page.getByRole("button", { name: "Model Stub One" })).toBeVisible();
  const first = sessionOf(client, "pi");
  // The first offered model row is the driver's current model, so the launch records it.
  expect(first).toMatchObject({
    view: "chat",
    terminalId: null,
    launch: { model: "stub/stub-1", profile: null },
  });
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("Keep the original chat draft");
  await page.getByRole("button", { name: "Model Stub One" }).click();
  const models = page.getByRole("dialog", { name: "Chat model" });
  await models.getByRole("option", { name: /Stub Two/ }).click();
  await expect.element(models).toBeVisible();
  await expect.element(models.getByRole("button", { name: "max", exact: true })).toBeVisible();
  await expect
    .element(models.getByRole("button", { name: "low", exact: true }))
    .not.toBeInTheDocument();
  await models.getByRole("button", { name: "max", exact: true }).click();
  await expect.element(models).toBeVisible();
  await expect.element(models.getByRole("button", { name: "max", exact: true })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(models).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Reasoning max" })).toBeVisible();
  await expect.element(message).toHaveValue("Keep the original chat draft");
  await expect.element(message).toHaveFocus();
  await page.getByRole("button", { name: "Model Stub Two" }).click();
  const profile = models.getByRole("radio", { name: /pi work/ });
  await expect.element(profile).toHaveAttribute("aria-disabled", "true");
  await profile.hover();
  await expect
    .element(page.getByRole("tooltip"))
    .toHaveTextContent("Switching agents in a running chat is not supported yet.");
  await profile.click({ force: true });
  // The task's shell and its one chat: the dialog changes the model, never launches.
  await vi.waitFor(() => expect(client.sessions.getSnapshot().sessions).toHaveLength(2));
  // Per-session draft isolation is covered in chat-tab; here the refusal is the claim.
});

test("a separate pi chat starts only after choosing its model and thinking and confirming", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Selected additional session");
  const before = client.sessions.getSnapshot().sessions.length;
  await openAgentSessionPicker("chat");
  await picker().getByRole("radio", { name: "pi", exact: true }).click();
  await picker()
    .getByRole("option", { name: /Stub Two/ })
    .click();
  await expect.element(picker()).not.toBeInTheDocument();
  expect(client.sessions.getSnapshot().sessions).toHaveLength(before);
  await setup()
    .getByRole("button", { name: /^Reasoning/ })
    .click();
  await picker().getByRole("button", { name: "high", exact: true }).click();
  await expect.element(picker()).not.toBeInTheDocument();
  expect(client.sessions.getSnapshot().sessions).toHaveLength(before);
  await expect.element(setup().getByRole("button", { name: "Reasoning high" })).toBeVisible();
  await startSelected();
  await expect.element(page.getByRole("button", { name: "Model Stub Two" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Reasoning high" })).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("first additional prompt");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByRole("log", { name: "Chat transcript" }))
    .toMatchTextContent("first additional prompt");
});

test("a separate OpenCode chat starts on the chosen catalog model and offers no thinking", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "OpenCode model first");
  const before = client.sessions.getSnapshot().sessions.length;
  await openAgentSessionPicker("chat");
  await picker().getByRole("radio", { name: "opencode", exact: true }).click();
  const option = picker().getByRole("option", { name: /Other Model/ });
  await expect.element(option).toBeVisible();
  await option.click();
  await expect.element(picker()).not.toBeInTheDocument();
  expect(client.sessions.getSnapshot().sessions).toHaveLength(before);

  // The chosen catalog ref rides on the setup dialog; OpenCode has no thinking levels to choose.
  await expect
    .element(setup().getByRole("button", { name: "Agent opencode · other-model" }))
    .toBeVisible();
  await expect
    .element(setup().getByRole("button", { name: "Reasoning", exact: true }))
    .toBeDisabled();

  await startSelected();
  const session = await startedAgent(client, "opencode");
  expect(session.launch).toMatchObject({
    kind: "opencode",
    expectedModel: { provider: "other", id: "other-model" },
  });
  await page.getByRole("textbox", { name: "Message" }).fill("opencode first additional");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByRole("log", { name: "Chat transcript" }))
    .toMatchTextContent("opencode first additional");
  // The first turn reports the model the session was created on.
  await expect.element(page.getByRole("button", { name: "Model Other Model" })).toBeVisible();

  // The capability is the UI's only reason: no level list, a sentence instead.
  await page.getByRole("button", { name: "Thinking", exact: true }).click();
  const levels = page.getByRole("dialog", { name: "Reasoning level" });
  await expect
    .element(levels)
    .toMatchTextContent("This agent does not support changing reasoning.");
  await userEvent.keyboard("{Escape}");
  await expect.element(levels).not.toBeInTheDocument();
});

test("a separate Codex chat starts only after explicitly confirming its model and effort", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Codex additional session");
  const before = client.sessions.getSnapshot().sessions.length;
  await openAgentSessionPicker("chat");
  await picker().getByRole("radio", { name: "codex", exact: true }).click();
  await picker()
    .getByRole("option", { name: /Stub Two/ })
    .click();
  await expect.element(picker()).not.toBeInTheDocument();
  expect(client.sessions.getSnapshot().sessions).toHaveLength(before);
  await setup()
    .getByRole("button", { name: /^Reasoning/ })
    .click();
  await picker().getByRole("button", { name: "high", exact: true }).click();
  await expect.element(setup().getByRole("button", { name: "Reasoning high" })).toBeVisible();
  expect(client.sessions.getSnapshot().sessions).toHaveLength(before);
  await startSelected();
  await expect.element(page.getByRole("button", { name: "Model Stub Two" })).toBeVisible();
  await page.getByRole("textbox", { name: "Message" }).fill("Codex additional first prompt");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByRole("log", { name: "Chat transcript" }))
    .toMatchTextContent("Codex additional first prompt");
  await expect
    .element(page.getByRole("button", { name: "Stop", exact: true }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Model Stub Two" }).click();
  const models = page.getByRole("dialog", { name: "Chat model" });
  await models.getByRole("option", { name: /Stub Three/ }).click();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("button", { name: "Model Stub Three" })).toBeVisible();
  // Stub Three does not offer Stub Two's `high`, and a model switch carries no level of its own:
  // the next turn runs on the native default this app-server confirmed, so the send is allowed.
  await expect.element(page.getByRole("button", { name: "Thinking", exact: true })).toBeVisible();
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("Codex next selected prompt");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(page.getByRole("log", { name: "Chat transcript" }))
    .toMatchTextContent("Codex next selected prompt");
  await expect.element(message).toHaveValue("");
});

test("a Codex default the next model does not offer refuses the send and keeps the draft", async () => {
  // The app-server's configured effort is `high`; Stub Three offers only `off` and `medium`.
  await withServerEnv("FAKE_CODEX_EFFORT", "high");
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Codex configured default");
  await openAgentSessionPicker("chat");
  await picker().getByRole("radio", { name: "codex", exact: true }).click();
  await picker()
    .getByRole("option", { name: /Stub Two/ })
    .click();
  await setup()
    .getByRole("button", { name: /^Reasoning/ })
    .click();
  await picker().getByRole("button", { name: "high", exact: true }).click();
  await startSelected();
  await expect.element(page.getByRole("button", { name: "Model Stub Two" })).toBeVisible();
  await page.getByRole("button", { name: "Model Stub Two" }).click();
  await page
    .getByRole("dialog", { name: "Chat model" })
    .getByRole("option", { name: /Stub Three/ })
    .click();
  await userEvent.keyboard("{Escape}");
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("Codex unoffered default prompt");
  await userEvent.keyboard("{Enter}");
  await expect
    .element(
      page.getByRole("alert").filter({
        hasText: "The configured Codex reasoning default is not offered by this model.",
      }),
    )
    .toBeVisible();
  await expect.element(message).toHaveValue("Codex unoffered default prompt");
});
