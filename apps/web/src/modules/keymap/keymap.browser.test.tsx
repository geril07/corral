import type { CorralClient } from "@corral/client/corral-client";
import { ActionId } from "@corral/protocol/config";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { writeConfig } from "../../../test/config-command.ts";
import { prefixShifted, prefixThen, realServerClients } from "../../../test/real-client.ts";
import { App } from "../../../test/render-app.tsx";
import {
  appWithProject,
  focusedIsTerminal,
  shellTabs,
  taskWithShell,
} from "../../../test/task-flows.tsx";
import { ACTION_LABELS } from "./actions.ts";

const { newClient } = realServerClients();
const picker = () => page.getByRole("dialog", { name: "New agent session" });
const palette = () => page.getByRole("dialog", { name: "Command palette" });
const paletteItem = (name: RegExp) => palette().getByRole("option", { name });
const reasonText = (text: string) => page.getByText(text, { exact: true });
const modelDialog = () => page.getByRole("dialog", { name: "Chat model" });
const reasoningDialog = () => page.getByRole("dialog", { name: "Reasoning level" });
const currentTaskId = () =>
  document
    .querySelector<HTMLElement>('[data-task-id][aria-current="true"]')
    ?.getAttribute("data-task-id");

/** A refused chord: no dialog, and the one reason in the shell's guidance row. */
async function assertRefused(press: () => Promise<void>, reason: string) {
  await press();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(reasonText(reason)).toBeVisible();
}

/** Writes the file and waits until the client has the config the server derived from it. */
async function applyConfig(client: CorralClient, text: string, applied: () => void) {
  await writeConfig(text);
  await vi.waitFor(applied);
  await expect.poll(() => client.config.getSnapshot().loaded).toBe(true);
}

test("number keys select the n-th session of the current task in the focused group", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Numbers");
  await prefixThen("c");
  await prefixThen("c");
  const third = shellTabs().nth(2);
  await expect.element(third).toHaveAttribute("aria-selected", "true");

  await prefixThen("2");
  await expect.element(shellTabs().nth(1)).toHaveAttribute("aria-selected", "true");
  await expect.element(third).toHaveAttribute("aria-selected", "false");

  await prefixThen("1");
  await expect.element(shellTabs().nth(0)).toHaveAttribute("aria-selected", "true");

  // A number past the task's sessions keeps the current one.
  await prefixThen("9");
  await expect.element(shellTabs().nth(0)).toHaveAttribute("aria-selected", "true");
});

test("a binding for the removed reopen action is reported as an unknown action", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await applyConfig(client, '[keys.bindings]\nreopen-closed-tab = "shift+q"\n', () =>
    expect(client.config.getSnapshot().problems).toHaveLength(1),
  );
  expect(client.config.getSnapshot().problems[0]).toMatchObject({
    severity: "error",
    path: "keys.bindings.reopen-closed-tab",
  });
  expect(client.config.getSnapshot().problems[0]?.message).toContain(
    'unknown action "reopen-closed-tab"',
  );
  // The removed action is not part of the bindings the client reads, and nothing ran from it.
  expect(client.config.getSnapshot().config.keys.bindings).not.toHaveProperty("reopen-closed-tab");
});

test("a binding for the removed changes action is reported as an unknown action", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await applyConfig(client, '[keys.bindings]\nchanges = "shift+c"\n', () =>
    expect(client.config.getSnapshot().problems).toHaveLength(1),
  );
  expect(client.config.getSnapshot().problems[0]).toMatchObject({
    severity: "error",
    path: "keys.bindings.changes",
  });
  expect(client.config.getSnapshot().problems[0]?.message).toContain('unknown action "changes"');
  // The key is not in the bindings the client reads, so nothing is dispatched from it.
  expect(client.config.getSnapshot().config.keys.bindings).not.toHaveProperty("changes");
});

test("a config file rebinds an action and the chord follows it", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Keymap");
  await applyConfig(client, '[keys.bindings]\nnew-agent = "a"\n', () =>
    expect(client.config.getSnapshot().config.keys.bindings["new-agent"]).toBe("a"),
  );

  await prefixThen("a");
  await expect.element(picker()).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(picker()).not.toBeInTheDocument();

  await prefixThen("s");
  await expect.element(picker()).not.toBeInTheDocument();
});

test("the sidebar-list action is rebindable, and a file chord on its default conflicts", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Keyboard way out");
  const row = page.getByRole("button", { name: /Keyboard way out/ });
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await prefixThen("w");
  await expect.element(row).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(page.getByRole("region", { name: "active terminal" }));
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  // A chord in the file wins over the default, and the default key then does nothing.
  await applyConfig(client, '[keys.bindings]\nfocus-sidebar = "y"\n', () =>
    expect(client.config.getSnapshot().config.keys.bindings["focus-sidebar"]).toBe("y"),
  );
  await prefixThen("w");
  await expect.element(row).not.toHaveFocus();
  await prefixThen("y");
  await expect.element(row).toHaveFocus();

  // The default is not a chord the file can take: the explicit entry is dropped and reported.
  await applyConfig(client, '[keys.bindings]\ntoggle-sidebar = "w"\n', () =>
    expect(client.config.getSnapshot().problems).toHaveLength(1),
  );
  expect(client.config.getSnapshot().problems[0]).toMatchObject({
    path: "keys.bindings.toggle-sidebar",
  });
  await userEvent.keyboard("{Escape}");
  await prefixThen("w");
  await expect.element(row).toHaveFocus();
});

test("a config file unbinds an action, whose key then does nothing", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await applyConfig(client, '[keys.bindings]\nnew-terminal = ""\n', () =>
    expect(client.config.getSnapshot().config.keys.bindings["new-terminal"]).toBeNull(),
  );
  await prefixThen("c");

  await expect.element(shellTabs()).toHaveLength(0);
});

test("a config file changes the prefix and every action follows it", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Prefix");
  await applyConfig(client, '[keys]\nprefix = "ctrl+b"\n', () =>
    expect(client.config.getSnapshot().config.keys.prefix).toBe("ctrl+b"),
  );
  await userEvent.keyboard("{Control>}b{/Control}c");
  await expect.element(shellTabs()).toHaveLength(2);

  await prefixThen("c");
  await expect.element(shellTabs()).toHaveLength(2);
});

test("the chat picker chords refuse on a shell, and the next chords still work", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Shell chords");
  await expect.element(shellTabs().first()).toHaveAttribute("aria-selected", "true");

  await assertRefused(() => prefixThen("m"), "Only a running chat session has a model control.");
  await assertRefused(
    () => prefixShifted("m"),
    "Only a running chat session has a reasoning control.",
  );

  // The task is still live: another shell opens with no recovery step.
  await prefixThen("c");
  await expect.element(shellTabs()).toHaveLength(2);
});

test("both chat picker chords apply on a running chat, and the picker closes when its chat stops", async () => {
  const { client, project } = await appWithProject(newClient());
  const task = await client.connection.api.tasks.create({
    projectId: project.id,
    title: "Picker work",
    prompt: "Picker work",
    agent: { kind: "pi", view: "chat" },
    workspace: { type: "main-worktree" },
  });
  await page.getByRole("button", { name: /Picker work/ }).click();
  await expect
    .element(page.getByRole("log", { name: "Chat transcript" }))
    .toMatchTextContent("Picker work");
  const session = await vi.waitFor(() => {
    const found = client.sessions
      .getSnapshot()
      .sessions.find(
        (each) =>
          each.taskId === task.id &&
          each.kind === "pi" &&
          each.view === "chat" &&
          each.state === "running",
      );
    if (found === undefined) throw new Error("the running chat is not in the store yet");
    return found;
  });

  // The model chord opens the picker on a running chat, and a model applies.
  await prefixThen("m");
  await expect.element(modelDialog()).toBeVisible();
  await expect.element(modelDialog().getByRole("option", { name: /Stub Two/ })).toBeVisible();
  await modelDialog()
    .getByRole("option", { name: /Stub Two/ })
    .click();
  await userEvent.keyboard("{Escape}");
  await expect.element(modelDialog()).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Model Stub Two" })).toBeVisible();

  // The reasoning chord opens it too; a level applies and keeps the picker open.
  await prefixShifted("m");
  await expect.element(reasoningDialog()).toBeVisible();
  await reasoningDialog().getByRole("button", { name: "high" }).click();
  await expect.element(reasoningDialog()).toBeVisible();
  await expect.element(reasoningDialog().getByRole("button", { name: "high" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(reasoningDialog()).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Reasoning high" })).toBeVisible();

  // Open the model picker again, then let the chat stop under it: the dialog closes and no stale
  // dialog keeps the prefix disarmed.
  await prefixThen("m");
  await expect.element(modelDialog()).toBeVisible();
  await client.connection.api.sessions.stop({ id: session.id });
  await expect.element(modelDialog()).not.toBeInTheDocument();
  await prefixThen("m");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

test("every action is listed, and a disabled row carries the sentence its chord would show", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await prefixThen(" ");

  const options = palette().getByRole("option").elements();
  expect(options).toHaveLength(ActionId.options.length);
  const bindingOf = client.config.getSnapshot().config.keys.bindings;
  const prefix = client.config.getSnapshot().config.keys.prefix;
  const observed = ActionId.options.map((action) => {
    const label = ACTION_LABELS[action];
    const row = options.find(
      (option) => option.querySelector("[data-palette-label]")?.textContent === label,
    );
    if (row === undefined) throw new Error(`the palette has no row for ${action}`);
    return {
      action,
      disabled: row.getAttribute("aria-disabled") === "true",
      reason: row.querySelector("[data-palette-reason]")?.textContent?.trim(),
      text: row.textContent ?? "",
      chord: row.querySelector("kbd")?.textContent?.trim(),
    };
  });
  expect(observed.map((row) => row.action)).toEqual([...ActionId.options]);
  expect(observed.map((row) => row.chord)).toEqual(
    ActionId.options.map((action) =>
      bindingOf[action] === null ? "unbound" : `${prefix} ${bindingOf[action]}`,
    ),
  );
  // A disabled row is a promise about the chord: the same sentence, never a silent no-op.
  expect(
    observed
      .filter((row) => row.disabled && (row.reason === undefined || row.reason === ""))
      .map((row) => row.action),
  ).toEqual([]);
  expect(
    observed
      .filter((row) => row.disabled && row.reason !== undefined && !row.text.includes(row.reason))
      .map((row) => row.action),
  ).toEqual([]);
  expect(observed.filter((row) => !row.disabled && row.reason !== undefined)).toEqual([]);

  // An action unavailable in an empty shell says the same sentence from its chord and its row.
  await userEvent.keyboard("{Escape}");
  await prefixThen("e");
  await expect.element(reasonText("Select a task to rename.")).toBeVisible();
});

test("prefix space filters the list, runs the action, and Escape keeps focus where it belongs", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Palette");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await prefixThen(" ");
  await expect.element(palette().getByRole("combobox", { name: "Commands" })).toHaveFocus();
  await expect.element(paletteItem(/^New terminal/)).toMatchTextContent("alt+a c");

  await userEvent.keyboard("new terminal");
  await expect.element(paletteItem(/^New terminal/)).toBeVisible();
  await expect.element(paletteItem(/^Add project/)).not.toBeInTheDocument();
  await userEvent.keyboard("{Enter}");

  await expect.element(palette()).not.toBeInTheDocument();
  await expect.element(shellTabs()).toHaveLength(2);
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  // Escape returns the keyboard to the terminal, not to the closed dialog.
  await prefixThen(" ");
  await expect.element(palette()).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(palette()).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
});

test("an action opened from the palette takes focus from the closing palette", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithShell(client, project.id, "Palette destination");

  await prefixThen(" ");
  await userEvent.keyboard("find task");
  await userEvent.keyboard("{Enter}");

  await expect.element(palette()).not.toBeInTheDocument();
  const find = page.getByRole("dialog", { name: "Find task" });
  await expect.element(find).toBeVisible();
  await expect.element(find.getByRole("combobox", { name: "Search tasks" })).toHaveFocus();
});

test("the palette's next and previous task rows move the selection", async () => {
  const { client, project } = await appWithProject(newClient());
  await Promise.all(
    ["First task", "Second task"].map((title) =>
      client.connection.api.tasks.create({
        projectId: project.id,
        title,
        workspace: { type: "main-worktree" },
      }),
    ),
  );
  await vi.waitFor(() =>
    expect(page.getByRole("button", { name: /Second task/ }).elements()).toHaveLength(1),
  );
  await page.getByRole("button", { name: /First task/ }).click();
  const first = currentTaskId();

  await prefixThen(" ");
  await userEvent.keyboard("next task");
  await userEvent.keyboard("{Enter}");
  await expect.element(palette()).not.toBeInTheDocument();
  await expect.poll(currentTaskId).not.toBe(first);

  await prefixThen(" ");
  await userEvent.keyboard("previous task");
  await userEvent.keyboard("{Enter}");
  await expect.poll(currentTaskId).toBe(first);
});
