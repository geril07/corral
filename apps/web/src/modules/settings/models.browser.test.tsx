import { defaultModelPolicy, modelScopeKey } from "@corral/protocol/models";
import { createHashHistory } from "@tanstack/react-router";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { App as RootApp } from "../../../src/app/app.tsx";
import { createGitRepo } from "../../../test/git-repo.ts";
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
const closeRefusal = () =>
  page.getByRole("status").filter({ hasText: "The save must finish before Settings can close." });

/** The real hash history, so a picker-owned Settings close is tested against browser Back. */
async function renderHashApp(client: ReturnType<typeof newClient>, entries: string[]) {
  const original = window.location.href;
  window.history.replaceState({}, "", `/#${entries[0]}`);
  const history = createHashHistory();
  for (const entry of entries.slice(1)) {
    history.push(entry);
    history.flush();
  }
  const rendered = await render(<RootApp client={client} history={history} />);
  return {
    ...rendered,
    history,
    restore: () => {
      history.destroy();
      window.history.replaceState({}, "", original);
    },
  };
}

const saveButton = () => models().getByRole("button", { name: "Save", exact: true });
const savedStatus = () => models().getByRole("status").filter({ hasText: "Saved · revision" });
const unsavedStatus = () => models().getByRole("status").filter({ hasText: "Unsaved changes" });
const savingStatus = () => models().getByRole("status").filter({ hasText: "Saving…" });
const findModels = () => models().getByRole("textbox", { name: "Find models" });

async function openManager() {
  const client = newClient();
  await writeConfig('[tasks]\nagent = "pi"\n');
  const { rendered } = await appWithProject(client);
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
  return { client, composer, rendered };
}

/** Holds the next models.save until the test releases it, then saves. */
function holdNextSave(client: ReturnType<typeof newClient>) {
  const api = client.connection.api;
  const save = api.models.save;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gatedModels = new Proxy(api.models, {
    get(target, property, receiver) {
      if (property === "save")
        return async (input: Parameters<typeof save>[0]) => {
          await gate;
          return save(input);
        };
      return Reflect.get(target, property, receiver);
    },
  });
  Object.defineProperty(client.connection, "api", {
    configurable: true,
    value: new Proxy(api, {
      get(target, property, receiver) {
        if (property === "models") return gatedModels;
        return Reflect.get(target, property, receiver);
      },
    }),
  });
  return { release };
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

test("picker-owned Settings announces a busy close, keeps the draft and does not navigate", async () => {
  const { client, rendered } = await openManager();
  const url = rendered.history.location.href;
  await models().getByRole("button", { name: "Only selected", exact: true }).click();
  await checkbox("Show Stub Two · stub").click();
  const { release } = holdNextSave(client);
  const save = models().getByRole("button", { name: "Save", exact: true });
  await save.click();
  await expect.element(save).toBeDisabled();
  const close = settings().getByRole("button", { name: "Back to workspace" });

  await close.click();
  await expect.element(closeRefusal()).toHaveLength(1);
  await expect.element(settings()).toBeVisible();
  await expect.element(checkbox("Show Stub Two · stub")).toBeChecked();
  expect(rendered.history.location.href).toBe(url);

  await userEvent.keyboard("{Escape}");
  await expect.element(closeRefusal()).toHaveLength(1);
  await expect.element(settings()).toBeVisible();
  await expect.element(checkbox("Show Stub Two · stub")).toBeChecked();
  expect(rendered.history.location.href).toBe(url);

  release();
  await expect.element(models().getByText("Saved ·", { exact: false })).toBeVisible();
  await expect.element(closeRefusal()).not.toBeInTheDocument();
  await expect.element(settings()).toBeVisible();
  expect(rendered.history.location.href).toBe(url);
});

test("another client's save makes a dirty draft stale: Save is disabled with its reason, Discard loads the latest and clears it", async () => {
  const { client } = await openManager();
  const peer = newClient();
  await vi.waitFor(() => expect(client.modelPreferences.getSnapshot().loaded).toBe(true));
  await vi.waitFor(() => expect(peer.connection.state.getSnapshot().status).toBe("connected"));
  const saved = () =>
    client.modelPreferences
      .getSnapshot()
      .items.find((p) => modelScopeKey(p.scope) === modelScopeKey(scope));
  const baseRevision = saved()?.revision ?? 0;
  await models().getByRole("button", { name: "Only selected", exact: true }).click();
  await checkbox("Show Stub Two · stub").click();
  await expect
    .element(unsavedStatus())
    .toMatchTextContent(`Unsaved changes · revision ${baseRevision}`);

  await peer.connection.api.models.save({
    scope,
    revision: baseRevision,
    policy: { ...defaultModelPolicy(), deny: [{ type: "provider", provider: "stub" }] },
  });
  const reason = models().getByRole("alert");
  await expect.element(reason).toMatchTextContent("Changed in another client");
  await expect.element(reason).toMatchTextContent("Your draft is kept");
  await expect
    .element(reason)
    .toMatchTextContent("Discard loads the latest version and drops the draft");
  await vi.waitFor(() => expect(saved()?.revision).toBe(baseRevision + 1));
  await expect.element(saveButton()).toBeDisabled();
  const describedBy = saveButton().element().getAttribute("aria-describedby");
  expect(describedBy).not.toBeNull();
  expect(document.getElementById(describedBy ?? "")).toBe(reason.element());
  await expect
    .element(unsavedStatus())
    .toMatchTextContent(`Unsaved changes · revision ${baseRevision}`);
  await expect.element(checkbox("Show Stub Two · stub")).toBeChecked();

  await settings().getByRole("button", { name: "Back to workspace" }).click();
  const confirm = page.getByRole("alertdialog", {
    name: "Discard unsaved model preferences?",
  });
  await expect.element(confirm).toBeVisible();
  await expect
    .element(confirm.getByRole("button", { name: "Keep editing", exact: true }))
    .toHaveFocus();
  await confirm.getByRole("button", { name: "Keep editing", exact: true }).click();
  await expect.element(confirm).not.toBeInTheDocument();
  await expect.element(checkbox("Show Stub Two · stub")).toBeChecked();

  await models().getByRole("button", { name: "Discard", exact: true }).click();
  await expect.element(reason).not.toBeInTheDocument();
  await expect.element(checkbox("Show Stub Two · stub")).not.toBeChecked();
  await expect.element(checkbox("Show Stub Two · stub")).toBeDisabled();
  await expect.element(savedStatus()).toMatchTextContent(`Saved · revision ${baseRevision + 1}`);
  await expect.element(saveButton()).toBeDisabled();
  await settings().getByRole("button", { name: "Back to workspace" }).click();
  await expect.element(picker().getByRole("combobox", { name: "Models" })).toHaveValue("stub");
});

test("an idle editor takes another client's save and stays clean", async () => {
  const { client } = await openManager();
  const peer = newClient();
  await vi.waitFor(() => expect(client.modelPreferences.getSnapshot().loaded).toBe(true));
  await vi.waitFor(() => expect(peer.connection.state.getSnapshot().status).toBe("connected"));
  const saved = client.modelPreferences
    .getSnapshot()
    .items.find((p) => modelScopeKey(p.scope) === modelScopeKey(scope));
  const baseRevision = saved?.revision ?? 0;
  await peer.connection.api.models.save({
    scope,
    revision: baseRevision,
    policy: { ...defaultModelPolicy(), deny: [{ type: "provider", provider: "stub" }] },
  });
  await expect.element(savedStatus()).toMatchTextContent(`Saved · revision ${baseRevision + 1}`);
  await expect.element(checkbox("Show Stub One · stub")).not.toBeChecked();
  await expect.element(checkbox("Show Stub One · stub")).toBeDisabled();
  await expect.element(saveButton()).toBeDisabled();
});

test("picker-owned Settings keeps its local confirm and does not register the routed history blocker", async () => {
  const client = newClient();
  await writeConfig('[tasks]\nagent = "pi"\n');
  await vi.waitFor(() => expect(client.connection.state.getSnapshot().status).toBe("connected"));
  const repo = await createGitRepo("picker-settings");
  const project = await client.connection.api.projects.add({ path: repo });
  await vi.waitFor(() =>
    expect(client.projects.getSnapshot().projects.some((each) => each.id === project.id)).toBe(
      true,
    ),
  );
  const { history, restore } = await renderHashApp(client, ["/", `/?project=${project.id}`]);
  try {
    await prefixThen("t");
    await promptField().fill("Keep this prompt and selection");
    await newTaskView()
      .getByRole("button", { name: /^Agent pi/ })
      .click();
    await expect.element(picker().getByRole("option", { name: /Stub Two/ })).toBeVisible();
    await picker().getByRole("combobox", { name: "Models" }).fill("stub");
    await picker().getByRole("button", { name: "Manage models…" }).click();
    await expect.element(settings()).toBeVisible();
    await expect.element(checkbox("Show Stub One · stub")).toBeVisible();
    await models().getByRole("button", { name: "Only selected", exact: true }).click();
    await checkbox("Show Stub Two · stub").click();

    const confirm = page.getByRole("alertdialog", {
      name: "Discard unsaved model preferences?",
    });
    await settings().getByRole("button", { name: "Back to workspace" }).click();
    await expect.element(confirm).toBeVisible();
    await expect
      .element(confirm.getByRole("button", { name: "Keep editing", exact: true }))
      .toHaveFocus();
    await confirm.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect.element(confirm).not.toBeInTheDocument();
    await expect
      .element(settings().getByRole("button", { name: "Back to workspace" }))
      .toHaveFocus();

    // No routed blocker here: browser Back navigates instead of asking the routed discard.
    history.back();
    await vi.waitFor(() => expect(window.location.hash).toBe("#/"));
    await expect.element(confirm).not.toBeInTheDocument();
  } finally {
    restore();
  }
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

test("a revision that changes while Save is in flight fails the save and keeps the draft", async () => {
  const { client } = await openManager();
  const peer = newClient();
  await vi.waitFor(() => expect(client.modelPreferences.getSnapshot().loaded).toBe(true));
  await vi.waitFor(() => expect(peer.connection.state.getSnapshot().status).toBe("connected"));
  const saved = client.modelPreferences
    .getSnapshot()
    .items.find((p) => modelScopeKey(p.scope) === modelScopeKey(scope));
  const baseRevision = saved?.revision ?? 0;
  await models().getByRole("button", { name: "Only selected", exact: true }).click();
  await checkbox("Show Stub Two · stub").click();
  const { release } = holdNextSave(client);
  await saveButton().click();
  await expect.element(saveButton()).toBeDisabled();
  await expect.element(savingStatus()).toHaveTextContent("Saving…");
  await expect.element(unsavedStatus()).not.toBeInTheDocument();

  await peer.connection.api.models.save({
    scope,
    revision: baseRevision,
    policy: { ...defaultModelPolicy(), deny: [{ type: "provider", provider: "stub" }] },
  });
  await expect.element(models().getByRole("alert")).toMatchTextContent("Changed in another client");
  await expect.element(savingStatus()).toHaveTextContent("Saving…");
  await expect.element(unsavedStatus()).not.toBeInTheDocument();
  release();

  await expect.element(models().getByText("Could not save.", { exact: false })).toBeVisible();
  await expect.element(models().getByText("Your draft is intact", { exact: false })).toBeVisible();
  await expect.element(checkbox("Show Stub Two · stub")).toBeChecked();
  await expect
    .element(unsavedStatus())
    .toMatchTextContent(`Unsaved changes · revision ${baseRevision}`);
  await expect.element(savingStatus()).not.toBeInTheDocument();
  await expect.element(saveButton()).toBeDisabled();
});

test("the footer follows the save lifecycle: unsaved before the request, Saving… while it is held, Saved after the ack", async () => {
  const { client } = await openManager();
  await vi.waitFor(() => expect(client.modelPreferences.getSnapshot().loaded).toBe(true));
  const saved = () =>
    client.modelPreferences
      .getSnapshot()
      .items.find((p) => modelScopeKey(p.scope) === modelScopeKey(scope));
  const baseRevision = saved()?.revision ?? 0;
  await models().getByRole("button", { name: "Only selected", exact: true }).click();
  await checkbox("Show Stub Two · stub").click();
  await expect
    .element(unsavedStatus())
    .toMatchTextContent(`Unsaved changes · revision ${baseRevision}`);

  const { release } = holdNextSave(client);
  await saveButton().click();
  await expect.element(saveButton()).toBeDisabled();
  await expect.element(savingStatus()).toHaveTextContent("Saving…");
  await expect.element(unsavedStatus()).not.toBeInTheDocument();

  release();
  await expect.element(savedStatus()).toMatchTextContent(`Saved · revision ${baseRevision + 1}`);
  await expect.element(savingStatus()).not.toBeInTheDocument();
});

test("saving from the keyboard announces the footer status and returns focus there; a refused save keeps the draft and focus in the dialog", async () => {
  const { client } = await openManager();
  await vi.waitFor(() => expect(client.modelPreferences.getSnapshot().loaded).toBe(true));
  const saved = () =>
    client.modelPreferences
      .getSnapshot()
      .items.find((p) => modelScopeKey(p.scope) === modelScopeKey(scope));
  const nextRevision = (saved()?.revision ?? 0) + 1;
  await checkbox("Show Stub Two · stub").click();
  saveButton().element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(savedStatus()).toMatchTextContent(`Saved · revision ${nextRevision}`);
  expect(savedStatus().element().getAttribute("role")).toBe("status");
  expect(savedStatus().element().tabIndex).toBe(-1);
  await expect.element(savedStatus()).toHaveFocus();
  expect(document.activeElement).not.toBe(document.body);
  expect(settings().element().contains(document.activeElement)).toBe(true);
  await expect.element(saveButton()).toBeDisabled();
  saveButton().element().focus();
  expect(document.activeElement).toBe(savedStatus().element());
  await userEvent.keyboard("{Tab}");
  await expect
    .element(models().getByRole("button", { name: "Hide all", exact: true }))
    .toHaveFocus();
  models().getByRole("button", { name: "Preview", exact: true }).element().focus();
  await userEvent.keyboard("{Tab}");
  expect(document.activeElement).not.toBe(saveButton().element());
  await vi.waitFor(() => expect(saved()?.revision).toBe(nextRevision));
  const peer = newClient();
  await vi.waitFor(() => expect(peer.connection.state.getSnapshot().status).toBe("connected"));
  await checkbox("Show Stub Two · stub").click();
  const { release } = holdNextSave(client);
  saveButton().element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(saveButton()).toBeDisabled();
  await peer.connection.api.models.save({
    scope,
    revision: nextRevision,
    policy: { ...defaultModelPolicy(), mode: "allow" },
  });
  await expect.element(models().getByRole("alert")).toMatchTextContent("Changed in another client");
  release();
  await expect.element(models().getByText("Could not save.", { exact: false })).toBeVisible();
  await expect.element(checkbox("Show Stub Two · stub")).toBeChecked();
  await expect.element(unsavedStatus()).toHaveFocus();
  expect(settings().element().contains(document.activeElement)).toBe(true);
});

test("a pointer save also lands the keyboard on the footer status", async () => {
  const { client } = await openManager();
  await vi.waitFor(() => expect(client.modelPreferences.getSnapshot().loaded).toBe(true));
  const saved = () =>
    client.modelPreferences
      .getSnapshot()
      .items.find((p) => modelScopeKey(p.scope) === modelScopeKey(scope));
  const nextRevision = (saved()?.revision ?? 0) + 1;
  await checkbox("Show Stub Two · stub").click();
  await saveButton().click();
  await expect.element(savedStatus()).toMatchTextContent(`Saved · revision ${nextRevision}`);
  await expect.element(savedStatus()).toHaveFocus();
  expect(settings().element().contains(document.activeElement)).toBe(true);
});

test("a move made during an in-flight save is not pulled back by the ack", async () => {
  const { client } = await openManager();
  await vi.waitFor(() => expect(client.modelPreferences.getSnapshot().loaded).toBe(true));
  const saved = () =>
    client.modelPreferences
      .getSnapshot()
      .items.find((p) => modelScopeKey(p.scope) === modelScopeKey(scope));
  const nextRevision = (saved()?.revision ?? 0) + 1;
  await checkbox("Show Stub Two · stub").click();
  const { release } = holdNextSave(client);
  saveButton().element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(saveButton()).toBeDisabled();
  findModels().element().focus();
  await expect.element(findModels()).toHaveFocus();
  release();
  await expect.element(savedStatus()).toMatchTextContent(`Saved · revision ${nextRevision}`);
  await expect.element(findModels()).toHaveFocus();
  await expect.element(savedStatus()).not.toHaveFocus();
});

const settingsEntry = () => page.getByRole("button", { name: "Settings", exact: true });
const settingsCategories = () =>
  settings().getByRole("navigation", { name: "Settings categories" });
const previewDialog = () =>
  page.getByRole("dialog", { name: "Model visibility preview", exact: true });

/** Opens routed Settings at one viewport, closes Preview twice and Settings once with Escape. */
async function assertPreviewReturnsFocus(width: number, height: number) {
  await page.viewport(width, height);
  await settingsEntry().click();
  await expect.element(settings()).toBeVisible();
  await settingsCategories().getByRole("button", { name: "Models", exact: true }).click();
  const previewButton = models().getByRole("button", { name: "Preview", exact: true });
  await expect.element(checkbox("Show Stub One · stub")).toBeVisible();
  await previewButton.click();
  await expect.element(previewDialog()).toBeVisible();
  await expect.element(previewDialog().getByRole("option", { name: /Stub One/ })).toBeDisabled();
  await expect.element(previewDialog().getByRole("option", { name: /Stub Two/ })).toBeDisabled();
  await expect
    .element(previewDialog())
    .toMatchTextContent("Preview only. Thinking levels come from the running agent.");
  await expect
    .element(previewDialog())
    .toMatchTextContent("Preview of unsaved menu visibility. No session is changed.");

  // The nested dialog closes alone and returns its own opener, never the body.
  const closePreview = async () => {
    await userEvent.keyboard("{Escape}");
    await expect.element(previewDialog()).not.toBeInTheDocument();
    await expect.element(settings()).toBeVisible();
    expect(document.activeElement).not.toBe(document.body);
    expect(settings().element().contains(document.activeElement)).toBe(true);
    await expect.element(previewButton).toHaveFocus();
  };
  await closePreview();

  // A second open and close in the same Settings session keeps the same return target.
  await previewButton.click();
  await expect.element(previewDialog()).toBeVisible();
  await closePreview();

  // Settings still owns its opener: the next Escape leaves it and returns to that button.
  await userEvent.keyboard("{Escape}");
  await expect.element(settings()).not.toBeInTheDocument();
  await expect.element(settingsEntry()).toHaveFocus();
}

test("closing the Models Preview returns the keyboard to its button while Settings keeps its own opener", async () => {
  const client = newClient();
  await writeConfig('[tasks]\nagent = "pi"\n');
  await appWithProject(client);
  const originalViewport = { width: window.innerWidth, height: window.innerHeight };
  try {
    await assertPreviewReturnsFocus(1024, 640);
    await assertPreviewReturnsFocus(1920, 1080);
    expect(document.activeElement).toBe(settingsEntry().element());
  } finally {
    await page.viewport(originalViewport.width, originalViewport.height);
  }
});
