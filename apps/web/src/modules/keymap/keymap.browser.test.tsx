import type { CorralClient } from "@corral/client/corral-client";
import type { SessionsSnapshot } from "@corral/client/sessions-store";
import { Store } from "@corral/client/store";
import type { TasksSnapshot } from "@corral/client/tasks-store";
import type { Session, Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { writeConfig } from "../../../test/config-command.ts";
import { prefixShifted, prefixThen, realServerClients } from "../../../test/real-client.ts";
import { App } from "../../../test/render-app.tsx";
import {
  appWithProject,
  createTaskWithShell,
  focusedIsTerminal,
  newTaskView,
  promptField,
  sessionTab,
  shellTabs,
  taskButton,
  workspace,
} from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();
const terminalButtons = () => workspace().getByRole("button", { name: /^sh · / });
const shell = (name: string) => sessionTab(name);
const picker = () => page.getByRole("dialog", { name: "New agent session" });
const palette = () => page.getByRole("dialog", { name: "Command palette" });
const paletteItem = (name: RegExp) => palette().getByRole("option", { name });
const reasonText = (text: string) => page.getByText(text, { exact: true });
const modelDialog = () => page.getByRole("dialog", { name: "Chat model" });
const reasoningDialog = () => page.getByRole("dialog", { name: "Reasoning level" });

/** A refused chord: no dialog, and the one reason in the shell's guidance row. */
async function assertRefused(press: () => Promise<void>, reason: string) {
  await press();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(reasonText(reason)).toBeVisible();
}

/** Runs `read` with the interface scale applied, after the browser has adopted it. */
async function withInterfaceScale(scale: string, read: () => void) {
  const previous = document.documentElement.style.fontSize;
  document.documentElement.style.fontSize = scale;
  try {
    await vi.waitFor(() =>
      expect(
        Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
      ).toBeGreaterThan(16),
    );
    read();
  } finally {
    document.documentElement.style.fontSize = previous;
  }
}

/**
 * A selected terminal agent with no chat driver in the server's answer. The palette's Switch view
 * row then carries the 50-character reason from the issue, on a short label.
 */
function seededDriverlessWorkspace() {
  const real = newClient();
  const tasks = new Store<TasksSnapshot>({ loaded: true, tasks: [] });
  const sessions = new Store<SessionsSnapshot>({ loaded: true, sessions: [] });
  const capabilities = {
    loaded: true,
    drivers: [
      {
        kind: "pi",
        steer: true,
        followUp: true,
        approvals: true,
        modelSwitch: true,
        reasoningLevels: true,
        terminalView: "handoff-only",
      },
    ],
  } as const;
  const client: CorralClient = {
    ...real,
    tasks: {
      subscribe: tasks.subscribe,
      getSnapshot: tasks.getSnapshot,
      failure: { subscribe: () => () => {}, getSnapshot: () => undefined },
      retry: () => {},
      close: () => {},
    },
    sessions: {
      subscribe: sessions.subscribe,
      getSnapshot: sessions.getSnapshot,
      failure: { subscribe: () => () => {}, getSnapshot: () => undefined },
      retry: () => {},
      close: () => {},
    },
    chatCapabilities: {
      subscribe: () => () => {},
      getSnapshot: () => capabilities,
      close: () => {},
    },
  };
  return { client, real, tasks, sessions };
}

/** Writes the file and waits until the client has the config the server derived from it. */
async function applyConfig(client: CorralClient, text: string, applied: () => void) {
  await writeConfig(text);
  await vi.waitFor(applied);
  await expect.poll(() => client.config.getSnapshot().loaded).toBe(true);
}

test("number keys select the n-th session of the current task in sidebar order", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Numbers");
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

test("a config file rebinds an action and the key hint follows it", async () => {
  const { client } = await appWithProject(newClient());
  await createTaskWithShell("Keymap");
  await applyConfig(client, '[keys.bindings]\nnew-agent = "a"\n', () =>
    expect(client.config.getSnapshot().config.keys.bindings["new-agent"]).toBe("a"),
  );
  await prefixThen(" ");
  await expect.element(paletteItem(/New agent session/)).toMatchTextContent("alt+a a");
  await userEvent.keyboard("{Escape}");

  await prefixThen("a");
  await expect.element(picker()).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(picker()).not.toBeInTheDocument();

  await prefixThen("s");
  await expect.element(picker()).not.toBeInTheDocument();
});

test("the sidebar-list action is listed, rebindable, and a file chord on its default conflicts", async () => {
  const { client } = await appWithProject(newClient());
  await createTaskWithShell("Keyboard way out");
  const row = taskButton("Keyboard way out");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await prefixThen(" ");
  await expect.element(paletteItem(/Focus the sidebar list/)).toMatchTextContent("alt+a w");
  // Running it from the palette leaves the keyboard on the row, not on the closing dialog.
  await userEvent.keyboard("focus the sidebar list{Enter}");
  await expect.element(row).toHaveFocus();
  await userEvent.keyboard("{Escape}");
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

  await expect.element(terminalButtons()).toHaveLength(0);
});

test("a config file changes the prefix and every action follows it", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await applyConfig(client, '[keys]\nprefix = "ctrl+b"\n', () =>
    expect(client.config.getSnapshot().config.keys.prefix).toBe("ctrl+b"),
  );
  await expect.element(page.getByText("ctrl+b", { exact: true })).toBeVisible();

  await userEvent.keyboard("{Control>}b{/Control}c");
  await expect.element(terminalButtons()).toHaveLength(1);

  await prefixThen("c");
  await expect.element(terminalButtons()).toHaveLength(1);
});

test("from a loose terminal the palette navigates to the one task in both directions", async () => {
  const { client } = await appWithProject(newClient());
  await createTaskWithShell("Only");
  await client.connection.api.terminals.create({ size: { cols: 80, rows: 24 } });
  const noTask = workspace().getByRole("button", { name: /^Scratch\b/ });
  await expect.element(noTask).toBeVisible();

  await noTask.click();
  await prefixThen(" ");
  await expect.element(paletteItem(/Next task/)).toHaveAttribute("aria-disabled", "false");
  await expect.element(paletteItem(/Previous task/)).toHaveAttribute("aria-disabled", "false");
  await userEvent.keyboard("next task{Enter}");
  await expect.element(palette()).not.toBeInTheDocument();
  await expect.element(taskButton("Only")).toHaveAttribute("aria-current", "true");

  await noTask.click();
  await prefixThen(" ");
  await expect.element(paletteItem(/Previous task/)).toHaveAttribute("aria-disabled", "false");
  await userEvent.keyboard("previous task{Enter}");
  await expect.element(palette()).not.toBeInTheDocument();
  await expect.element(taskButton("Only")).toHaveAttribute("aria-current", "true");
});

test("config problems show as a notice whose dialog lists each one with the file path", async () => {
  const client = newClient();
  await render(<App client={client} />);
  await applyConfig(client, '[keys.bindings]\nnew-agent = "hyper+q"\nboard = "ctrl+w"\n', () =>
    expect(client.config.getSnapshot().problems).toHaveLength(2),
  );
  const path = client.config.getSnapshot().path;

  await page.getByRole("button", { name: "config: 2 problems" }).click();
  const dialog = page.getByRole("dialog", { name: "Config problems" });

  await expect.element(dialog).toMatchTextContent(path);
  await expect.element(dialog).toMatchTextContent("error");
  await expect.element(dialog).toMatchTextContent("keys.bindings.new-agent");
  await expect.element(dialog).toMatchTextContent('unknown modifier "hyper" in "hyper+q"');
  await expect.element(dialog).toMatchTextContent("warning");
  await expect.element(dialog).toMatchTextContent("keys.bindings.board");
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog).not.toBeInTheDocument();
});

test("the search dialog opened from the sidebar button returns focus there, not to the terminal", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Focus");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  const opener = workspace().getByRole("button", { name: "Search tasks" });

  await opener.click();
  const find = page.getByRole("dialog", { name: "Find task" });
  await expect.element(find).toBeVisible();
  await userEvent.keyboard("{Escape}");

  await expect.element(find).not.toBeInTheDocument();
  await expect.element(opener).toHaveFocus();
});

test("the palette opens from its key, shows bindings, filters, runs an action and Escape returns to the terminal", async () => {
  const client = newClient();
  await render(<App client={client} />);

  await prefixThen(" ");
  await expect.element(palette()).toBeVisible();
  await expect.element(palette().getByRole("combobox", { name: "Commands" })).toHaveFocus();
  await expect.element(paletteItem(/New terminal/)).toMatchTextContent("alt+a c");
  await expect.element(paletteItem(/Stop session/)).toHaveAttribute("aria-disabled", "true");
  // The chat abort action is in the same table; with no chat session it is listed but disabled.
  await expect.element(paletteItem(/Abort the working turn/)).toMatchTextContent("alt+a .");
  await expect
    .element(paletteItem(/Abort the working turn/))
    .toHaveAttribute("aria-disabled", "true");

  await userEvent.keyboard("new terminal");
  await expect.element(paletteItem(/New terminal/)).toBeVisible();
  await expect.element(paletteItem(/Add project/)).not.toBeInTheDocument();

  await userEvent.keyboard("{Enter}");
  await expect.element(palette()).not.toBeInTheDocument();
  await expect.element(terminalButtons()).toHaveLength(1);
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await prefixThen(" ");
  await expect.element(palette()).toBeVisible();
  await userEvent.keyboard("agent");
  await expect.element(paletteItem(/New agent session/)).toBeVisible();
  await userEvent.keyboard("{Escape}");

  await expect.element(palette()).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await userEvent.keyboard("echo back-$((7+7)){Enter}");
  await expect.poll(() => window.corralScreenText?.() ?? "").toContain("back-14");
});

test("the palette opens the board and Escape returns to the terminal", async () => {
  await render(<App client={newClient()} />);
  await prefixThen("c");
  await expect.element(terminalButtons()).toHaveLength(1);
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await prefixThen(" ");
  await userEvent.keyboard("open board");
  await expect.element(paletteItem(/Open board/)).toBeVisible();
  await userEvent.keyboard("{Enter}");

  const board = page.getByRole("region", { name: "Board" });
  await expect.element(board).toBeVisible();
  await expect.element(board.getByRole("button", { name: "Back to workspace" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");

  await expect.element(board).not.toBeInTheDocument();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await userEvent.keyboard("echo board-palette-$((4+4)){Enter}");
  await expect.poll(() => window.corralScreenText?.() ?? "").toContain("board-palette-8");
});

test("the chat picker chords refuse without a session and leave every prefix chord alive", async () => {
  await render(<App client={newClient()} />);
  await expect.element(page.getByText("Add a repository to start")).toBeVisible();

  // A disabled task action is refused with its reason, not run.
  await prefixThen("e");
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await expect.element(reasonText("Select a task to rename.")).toBeVisible();

  await assertRefused(() => prefixThen("m"), "Only a running chat session has a model control.");
  await assertRefused(
    () => prefixShifted("m"),
    "Only a running chat session has a reasoning control.",
  );

  // No dialog was set, so the next chord works without opening and closing anything.
  await prefixThen(" ");
  await expect.element(palette()).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(palette()).not.toBeInTheDocument();
});

test("the chat picker chords refuse on a shell, and the next chords still work", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Shell chords");
  await expect.element(shell("shell")).toHaveAttribute("aria-selected", "true");

  await assertRefused(() => prefixThen("m"), "Only a running chat session has a model control.");
  await assertRefused(
    () => prefixShifted("m"),
    "Only a running chat session has a reasoning control.",
  );

  // The task is still live: another shell opens, then the palette opens, with no recovery step.
  await prefixThen("c");
  await expect.element(shellTabs()).toHaveLength(2);
  await prefixThen(" ");
  await expect.element(palette()).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(palette()).not.toBeInTheDocument();
});

test("both chat picker chords apply on a running chat, and the picker closes when its chat stops", async () => {
  const { client } = await appWithProject(newClient());
  await prefixThen("t");
  await expect.element(promptField()).toHaveFocus();
  // The fake pi reports models and reasoning levels; claude would start without that catalog.
  await userEvent.click(newTaskView().getByRole("button", { name: /^Agent / }));
  await page
    .getByRole("dialog", { name: "Agent and model" })
    .getByRole("radio", { name: "pi", exact: true })
    .click();
  await userEvent.keyboard("{Escape}");
  await promptField().click();
  await userEvent.keyboard("Picker work{Enter}");
  await expect
    .element(page.getByRole("log", { name: "Chat transcript" }))
    .toMatchTextContent("Picker work");
  const session = await vi.waitFor(() => {
    const found = client.sessions
      .getSnapshot()
      .sessions.find(
        (each) => each.kind === "pi" && each.view === "chat" && each.state === "running",
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

  // The reasoning chord opens it too, and a level applies and closes.
  await prefixShifted("m");
  await expect.element(reasoningDialog()).toBeVisible();
  await reasoningDialog().getByRole("button", { name: "high" }).click();
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
  await expect
    .element(reasonText("Only a running chat session has a model control."))
    .toBeVisible();
  await prefixThen(" ");
  await expect.element(palette()).toBeVisible();
});

test("every disabled palette row carries a reason on a second line and keeps its binding", async () => {
  await render(<App client={newClient()} />);
  await prefixThen(" ");
  await expect.element(palette()).toBeVisible();

  const options = palette().getByRole("option").elements();
  const disabled = options.filter((option) => option.getAttribute("aria-disabled") === "true");
  expect(disabled.length).toBeGreaterThan(20);
  for (const option of disabled) {
    const reason = option.querySelector("[data-palette-reason]");
    expect(reason?.textContent?.trim()).not.toBe("");
    expect(option.querySelector("kbd")?.textContent?.trim()).not.toBe("");
  }
  for (const option of options.filter((each) => each.getAttribute("aria-disabled") !== "true")) {
    expect(option.querySelector("[data-palette-reason]")).toBeNull();
  }

  // The reason keeps its own line at 140% text, under the label rather than in its row.
  const reasoning = paletteItem(/Change the reasoning level/);
  const assertReasonBelow = () => {
    const option = reasoning.element();
    const label = option.querySelector("[data-palette-label]");
    const reason = option.querySelector("[data-palette-reason]");
    if (!(label instanceof HTMLElement) || !(reason instanceof HTMLElement)) {
      throw new Error("the disabled row has no label or reason line");
    }
    expect(reason.textContent).toBe("Only a running chat session has a reasoning control.");
    expect(reason.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      label.getBoundingClientRect().bottom - 1,
    );
  };
  assertReasonBelow();
  await withInterfaceScale("140%", assertReasonBelow);
});

test("a long driverless reason leaves its short action label whole at 1024 and 140%", async () => {
  const { client, real, tasks, sessions } = seededDriverlessWorkspace();
  const { repo } = await appWithProject(client);
  const project = await vi.waitFor(() => {
    const found = real.projects.getSnapshot().projects.find((each) => each.path === repo);
    if (found === undefined) throw new Error("the project is not in the list yet");
    return found;
  });
  const task: Task = {
    id: "task-long-reason",
    projectId: project.id,
    title: "Long reason",
    titleSource: "user",
    prompt: null,
    primarySessionId: "agent-claude-long",
    branch: "main",
    workspacePath: project.path,
    ownsWorktree: false,
    state: "active",
    seenAt: null,
    createdAt: 1,
  };
  const session: Session = {
    id: "agent-claude-long",
    taskId: task.id,
    kind: "claude",
    view: "terminal",
    agentSessionId: "claude-seeded",
    terminalId: null,
    state: "running",
    status: null,
    createdAt: 1,
  };
  tasks.set({ loaded: true, tasks: [task] });
  sessions.set({ loaded: true, sessions: [session] });
  await taskButton("Long reason").click();
  await prefixThen(" ");

  const row = paletteItem(/Switch view/);
  await expect.element(row).toBeVisible();
  const assertLabelWhole = () => {
    const option = row.element();
    const label = option.querySelector("[data-palette-label]");
    const reason = option.querySelector("[data-palette-reason]");
    if (!(label instanceof HTMLElement) || !(reason instanceof HTMLElement)) {
      throw new Error("the disabled row has no label or reason line");
    }
    expect(reason.textContent).toBe("The claude agent has no chat driver in this build.");
    expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth + 1);
    expect(reason.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      label.getBoundingClientRect().bottom - 1,
    );
  };
  assertLabelWhole();
  await withInterfaceScale("140%", assertLabelWhole);
});

test("a focus tooltip does not block the sidebar row underneath it", async () => {
  const { client } = await appWithProject(newClient());
  const project = client.projects.getSnapshot().projects[0]!;
  await client.connection.api.tasks.create({
    projectId: project.id,
    title: "Under the tooltip",
    workspace: { type: "new-branch" },
  });

  // The new-task icon always explains itself; focus opens its tooltip over the list below.
  workspace().getByRole("button", { name: "New task" }).element().focus();
  await expect.element(page.getByRole("tooltip")).toBeVisible();

  // Project grouping is the default; the tooltip must not intercept the project row's click.
  const header = workspace().getByRole("button", { name: new RegExp(`^${project.name}\\b`) });
  await expect.element(header).toHaveAttribute("aria-expanded", "true");
  await header.click();
  await expect.element(header).toHaveAttribute("aria-expanded", "false");
  await expect.element(taskButton("Under the tooltip")).not.toBeInTheDocument();
});
