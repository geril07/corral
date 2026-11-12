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

test("a named profile and a typed model reach the fake CLI and stay on the session", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Profiled");
  await applyConfig(client, PROFILES, 2);

  await openAgentSessionPicker("terminal");
  await expect.element(picker()).toBeVisible();
  await picker().getByRole("radio", { name: "Claude gateway" }).click();
  await picker().getByRole("textbox", { name: "Model override" }).fill("claude-opus-4-1");
  await userEvent.keyboard("{Enter}");

  await expect.element(picker()).not.toBeInTheDocument();
  const session = await startedAgent(client, "claude");
  expect(session.launch).toMatchObject({
    kind: "claude",
    profile: { id: "claude-gateway", name: "Claude gateway" },
    model: "claude-opus-4-1",
    provider: null,
  });
  await expect
    .poll(() => argvOf(session.id))
    .toEqual([["--model", "claude-opus-4-1", "--session-id", session.agentSessionId]]);
  await expect.poll(screenText).toContain("fake claude ready");

  // The tab names the agent; the launch snapshot above carries the profile and model.
  const tab = sessionTabs().getByRole("tab", { name: /^claude/ });
  await expect.element(tab).toBeVisible();

  // Stop, then change the profile in the file: the conversation keeps its snapshot.
  await prefixThen("x");
  await expect.element(stoppedPane()).toMatchTextContent("Claude gateway · claude-opus-4-1");

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
  await expect.element(stoppedPane()).toMatchTextContent("Claude gateway · claude-opus-4-1");
  await expect.element(stoppedPane()).not.toMatchTextContent("claude-haiku-4");
  expect(sessionOf(client, "claude").launch).toMatchObject({
    profile: { name: "Claude gateway" },
    model: "claude-opus-4-1",
  });
});

test("a native-default start carries no profile or model and never borrows the file's model", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Native");
  await applyConfig(client, PROFILES, 2);

  await openAgentSessionPicker("terminal");
  await picker().getByRole("radio", { name: "claude" }).click();
  await userEvent.keyboard("{Enter}");

  const session = await startedAgent(client, "claude");
  expect(session.launch).toBeNull();
  await expect.poll(() => argvOf(session.id)).toEqual([["--session-id", session.agentSessionId]]);

  await prefixThen("x");
  await expect.element(stoppedPane()).toMatchTextContent("agent default model");
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

  await expect
    .element(picker().getByRole("alert"))
    .toMatchTextContent("no environment variable PROFILE_MISSING_TOKEN");
  await expect.element(picker().getByRole("radio", { name: "Claude env" })).toBeChecked();
  expect(client.sessions.getSnapshot().sessions).toHaveLength(shells);

  // With the reference present, the same open picker completes the launch.
  await withServerEnv("PROFILE_MISSING_TOKEN", "not-a-real-token");
  await picker().getByRole("radio", { name: "Claude env" }).click();
  await userEvent.keyboard("{Enter}");
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
  await picker().getByRole("textbox", { name: "Model override" }).fill("claude-opus-4-1");
  await applyConfig(
    client,
    '[profiles.codex-work]\nname = "Codex work"\nagent = "codex"\nmodel = "gpt-5-codex"\n',
    1,
  );

  await expect
    .element(picker().getByRole("alert"))
    .toMatchTextContent("no longer in the config file");
  await expect
    .element(picker().getByRole("textbox", { name: "Model override" }))
    .toHaveValue("claude-opus-4-1");
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
  await picker().getByRole("textbox", { name: "Model override" }).fill("");
  await expect.element(start).toBeEnabled();
  await start.click();
  await expect.element(picker()).not.toBeInTheDocument();
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
    .toMatchTextContent("changed in the config file");
  const start = picker().getByRole("option").last();
  await expect.element(start).toBeDisabled();
  const beforeCount = client.sessions.getSnapshot().sessions.length;
  picker().getByRole("radio", { name: "claude" }).element().focus();
  await userEvent.keyboard("{Enter}");
  expect(client.sessions.getSnapshot().sessions).toHaveLength(beforeCount);

  await picker().getByRole("radio", { name: "Claude gateway" }).click();
  await expect.element(start).toBeEnabled();
  await start.click();

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

test("the live picker follows model-specific thinking and another profile starts a distinct chat", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Shared picker");
  await applyConfig(
    client,
    '[profiles.pi-work]\nname = "pi work"\nagent = "pi"\nmodel = "stub-1"\n',
    1,
  );
  await openAgentSessionPicker("chat");
  await picker().getByRole("radio", { name: "pi", exact: true }).click();
  await picker().getByRole("option").first().click();
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
  await expect.element(models).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Reasoning max" })).toBeVisible();
  await expect.element(message).toHaveValue("Keep the original chat draft");
  await expect.element(message).toHaveFocus();
  await page.getByRole("button", { name: "Model Stub Two" }).click();
  await models.getByRole("radio", { name: "pi work", exact: true }).click();
  await expect.element(models.getByRole("toolbar", { name: "Thinking" })).not.toBeInTheDocument();
  await models.getByRole("option").first().click();
  // The task's shell plus the two chat sessions.
  await vi.waitFor(() => expect(client.sessions.getSnapshot().sessions).toHaveLength(3));
  const second = client.sessions
    .getSnapshot()
    .sessions.find((session) => session.kind === "pi" && session.id !== first.id)!;
  expect(second).toMatchObject({
    kind: "pi",
    view: "chat",
    launch: { profile: { id: "pi-work" }, model: "stub-1" },
  });
  // Per-session draft isolation is covered in chat-tab; here the distinct launch is the claim.
});
