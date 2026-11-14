import type { CorralClient } from "@corral/client/corral-client";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { writeConfig } from "../../../test/config-command.ts";
import { prefixShifted, prefixThen, realServerClients } from "../../../test/real-client.ts";
import { App } from "../../../test/render-app.tsx";
import {
  appWithProject,
  focusedIsTerminal,
  sessionTab,
  shellTabs,
  taskWithShell,
} from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();
const shell = (name: string) => sessionTab(name);
const picker = () => page.getByRole("dialog", { name: "New agent session" });
const reasonText = (text: string) => page.getByText(text, { exact: true });
const modelDialog = () => page.getByRole("dialog", { name: "Chat model" });
const reasoningDialog = () => page.getByRole("dialog", { name: "Reasoning level" });

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
  await expect.element(shell("shell 3")).toHaveAttribute("aria-selected", "true");

  await prefixThen("2");
  await expect.element(shell("shell 2")).toHaveAttribute("aria-selected", "true");
  await expect.element(shell("shell 3")).toHaveAttribute("aria-selected", "false");

  await prefixThen("1");
  await expect.element(shell("shell")).toHaveAttribute("aria-selected", "true");

  // A number past the task's sessions keeps the current one.
  await prefixThen("9");
  await expect.element(shell("shell")).toHaveAttribute("aria-selected", "true");
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
  await applyConfig(client, '[keys.bindings]\nboard = "w"\n', () =>
    expect(client.config.getSnapshot().problems).toHaveLength(1),
  );
  expect(client.config.getSnapshot().problems[0]).toMatchObject({ path: "keys.bindings.board" });
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
  await expect.element(shell("shell")).toHaveAttribute("aria-selected", "true");

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
