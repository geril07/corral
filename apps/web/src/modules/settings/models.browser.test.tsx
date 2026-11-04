import { defaultModelPolicy, modelScopeKey } from "@corral/protocol/models";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { realServerClients, prefixThen } from "../../../test/real-client.ts";
import { writeConfig } from "../../../test/config-command.ts";
import {
  appWithProject,
  promptField,
  newTaskView,
  taskButton,
  sessionTabs,
} from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();
const scope = { kind: "pi" as const, profileId: null };
const picker = () => page.getByRole("dialog", { name: "Agent and model", exact: true });
const settings = () => page.getByRole("dialog", { name: "Settings", exact: true });
const models = () => page.getByRole("region", { name: "Models", exact: true });
const checkbox = (name: string) => models().getByRole("checkbox", { name, exact: true });

async function openManager() {
  const client = newClient();
  await writeConfig('[tasks]\nagent = "pi"\n');
  await appWithProject(client);
  await prefixThen("t");
  await promptField().fill("Keep this prompt and selection");
  const composer = promptField().element();
  await newTaskView()
    .getByRole("button", { name: /^Agent pi/ })
    .click();
  await expect.element(picker().getByRole("option", { name: /Stub Two/ })).toBeVisible();
  await picker().getByRole("combobox", { name: "Models" }).fill("stub");
  await picker().getByRole("button", { name: "Manage models…" }).click();
  await expect.element(settings()).toBeVisible();
  await expect.element(checkbox("Show Stub One · stub")).toBeVisible();
  return { client, composer };
}

test("the shared manager saves an exact whitelist and returns to picker search, focus and composer draft", async () => {
  const { client, composer } = await openManager();
  const peer = newClient();
  await models().getByRole("button", { name: "Only selected", exact: true }).click();
  await checkbox("Show Stub Two · stub").click();
  await expect
    .element(checkbox("Show provider stub including future models"))
    .toHaveAttribute("aria-checked", "mixed");
  await models().getByRole("button", { name: "Save", exact: true }).click();
  await vi.waitFor(() =>
    expect(
      peer.modelPreferences
        .getSnapshot()
        .items.find((p) => modelScopeKey(p.scope) === modelScopeKey(scope))?.policy.allow,
    ).toEqual([{ type: "model", provider: "stub", id: "stub-2" }]),
  );
  await settings().getByRole("button", { name: "Back to workspace" }).click();
  await expect.element(picker()).toBeVisible();
  await expect.element(picker().getByRole("combobox", { name: "Models" })).toHaveValue("stub");
  await expect.element(picker().getByRole("combobox", { name: "Models" })).toHaveFocus();
  await expect.element(picker().getByRole("option", { name: /Stub One/ })).not.toBeInTheDocument();
  await expect.element(picker().getByRole("option", { name: /Stub Two/ })).toBeVisible();
  await picker()
    .getByRole("option", { name: /Stub Two/ })
    .click();
  await expect.element(picker()).not.toBeInTheDocument();
  expect(promptField().element()).toBe(composer);
  await expect.element(promptField()).toHaveValue("Keep this prompt and selection");
  await expect.element(promptField()).toHaveFocus();
  await vi.waitFor(() => expect(client.tasks.getSnapshot().tasks).toHaveLength(0));
});

test("long profile names stay inside Settings with an actual-overflow full-name title", async () => {
  const { client } = await openManager();
  const name = "W".repeat(80);
  await writeConfig(`[tasks]\nagent = "pi"\n[profiles.long]\nname = "${name}"\nagent = "pi"\n`);
  await vi.waitFor(() => expect(client.config.getSnapshot().profiles[0]?.name).toBe(name));
  await models().getByRole("combobox", { name: "Model tool/profile", exact: true }).click();
  await page.getByRole("option", { name: `pi · ${name}`, exact: true }).click();
  const field = models()
    .getByRole("combobox", { name: "Model tool/profile", exact: true })
    .element();
  await vi.waitFor(() => expect(field.querySelector("[title]")?.getAttribute("title")).toBe(name));
  expect(models().element().scrollWidth).toBeLessThanOrEqual(models().element().clientWidth);
  expect(field.getBoundingClientRect().width).toBeLessThanOrEqual(320);
});

test("another client's save cannot replace or overwrite an editor draft; dirty close is explicit", async () => {
  const { client } = await openManager();
  await models().getByRole("button", { name: "Only selected", exact: true }).click();
  await checkbox("Show Stub Two · stub").click();
  const saved = client.modelPreferences
    .getSnapshot()
    .items.find((p) => modelScopeKey(p.scope) === modelScopeKey(scope));
  await client.connection.api.models.save({
    scope,
    revision: saved?.revision ?? 0,
    policy: { ...defaultModelPolicy(), deny: [{ type: "provider", provider: "stub" }] },
  });
  await expect.element(models().getByRole("alert")).toMatchTextContent("Changed in another client");
  await models().getByRole("button", { name: "Save", exact: true }).click();
  await expect.element(models().getByText("Could not save.", { exact: false })).toBeVisible();
  await expect.element(checkbox("Show Stub Two · stub")).toBeChecked();
  await settings().getByRole("button", { name: "Back to workspace" }).click();
  await expect
    .element(settings().getByText("Model preferences have unsaved changes.", { exact: true }))
    .toBeVisible();
  await settings().getByRole("button", { name: "Keep editing" }).click();
  await models().getByRole("button", { name: "Discard", exact: true }).click();
  await expect.element(checkbox("Show Stub Two · stub")).not.toBeChecked();
  await expect.element(checkbox("Show Stub Two · stub")).toBeDisabled();
  await settings().getByRole("button", { name: "Back to workspace" }).click();
  await expect.element(picker().getByRole("combobox", { name: "Models" })).toHaveValue("stub");
});

test("hiding a live model keeps its session, thinking, draft and composer node; other clients can reveal it again", async () => {
  const client = newClient();
  await appWithProject(client);
  const project = client.projects.getSnapshot().projects[0]!;
  const api = client.connection.api;
  const task = await api.tasks.create({
    title: "Model visibility",
    projectId: project.id,
    workspace: { type: "main-worktree" },
  });
  const session = await api.sessions.start({
    taskId: task.id,
    kind: "pi",
    view: "chat",
    size: { cols: 80, rows: 24 },
  });
  await taskButton("Model visibility").click();
  await sessionTabs().getByRole("tab", { name: /^pi/ }).click();
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await expect
    .element(page.getByRole("button", { name: "Model Stub One", exact: true }))
    .toBeVisible();
  await message.fill("An independent live draft");
  const composer = message.element();
  await page.getByRole("button", { name: "Model Stub One", exact: true }).click();
  const live = page.getByRole("dialog", { name: "Chat model", exact: true });
  await live.getByRole("button", { name: "Manage models…" }).click();
  await checkbox("Show provider stub including future models").click();
  await models().getByRole("button", { name: "Save", exact: true }).click();
  await expect.element(models().getByText("Saved ·", { exact: false })).toBeVisible();
  await settings().getByRole("button", { name: "Back to workspace" }).click();
  await expect
    .element(live.getByText("Current model is hidden by the filter; the session is unchanged."))
    .toBeVisible();
  await expect.element(live.getByRole("option", { name: /Stub Two/ })).not.toBeInTheDocument();
  await expect.element(live.getByRole("option", { name: /Stub One/ })).toBeDisabled();
  const chat = client.openChat(session.id);
  try {
    await vi.waitFor(() => expect(chat.getSnapshot().state.model?.id).toBe("stub-1"));
    expect(chat.getSnapshot().state.reasoning).toBe("medium");
    const peer = newClient();
    await vi.waitFor(() => expect(peer.modelPreferences.getSnapshot().loaded).toBe(true));
    const prefs = peer.modelPreferences
      .getSnapshot()
      .items.find((p) => modelScopeKey(p.scope) === modelScopeKey(scope))!;
    await peer.connection.api.models.save({ ...prefs, policy: defaultModelPolicy() });
    await expect.element(live.getByRole("option", { name: /Stub Two/ })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    expect(message.element()).toBe(composer);
    await expect.element(message).toHaveValue("An independent live draft");
    await expect.element(message).toHaveFocus();
    expect(client.sessions.getSnapshot().sessions.filter((s) => s.taskId === task.id)).toHaveLength(
      1,
    );
  } finally {
    chat.close();
  }
});
