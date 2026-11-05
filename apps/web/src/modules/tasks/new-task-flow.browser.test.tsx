import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { writeConfig } from "../../../test/config-command.ts";
import { agentLaunches } from "../../../test/fake-agents.ts";
import { createGitRepo } from "../../../test/git-repo.ts";
import { prefixThen, realServerClients, screenText } from "../../../test/real-client.ts";
import {
  appWithProject,
  createTaskWithShell,
  focusedIsTerminal,
  newTaskView,
  promptField,
  sessionTab,
  shellTabs,
  taskButton,
  taskHeader,
  workspace,
} from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();

/**
 * Opens the composer's workspace picker and waits for its search field to have the keyboard.
 * The popup focuses the field a frame after it opens; typing before that loses the text and Enter
 * then keeps the value that was already selected, which is how this file used to flake under load.
 */
async function openWorkspacePicker() {
  await userEvent.click(picker(/^Workspace /));
  await expect.element(page.getByRole("combobox", { name: "Search workspaces" })).toHaveFocus();
}

const picker = (name: RegExp) =>
  name.source.startsWith("^Agent ")
    ? newTaskView().getByRole("button", { name })
    : newTaskView().getByRole("combobox", { name });
async function pickAgent(name: string) {
  await picker(/^Agent /).click();
  await page
    .getByRole("dialog", { name: "Agent and model" })
    .getByRole("radio", { name, exact: true })
    .click();
  await userEvent.keyboard("{Escape}");
}

/** A fake agent's launch with the prompt as the agent would read it on its own command line. */
async function launchWithPrompt(prompt: string) {
  return (await agentLaunches()).find((launch) =>
    launch.argv.some((argument) => argument.trim() === prompt),
  );
}

test("the composer sits about a third down, with a four-line prompt in a centered column", async () => {
  await appWithProject(newClient());
  const region = page
    .getByRole("region", { name: "task content" })
    .element()
    .getBoundingClientRect();
  const prompt = promptField().element().getBoundingClientRect();
  const surface = promptField()
    .element()
    .closest("[data-slot=composer-surface]")!
    .getBoundingClientRect();

  // `layout.md` **New task view**: about a third of the height, four lines at rest.
  expect(prompt.top - region.top).toBeGreaterThan(region.height * 0.28);
  expect(prompt.top - region.top).toBeLessThan(region.height * 0.4);
  expect(prompt.height).toBeGreaterThanOrEqual(80);
  // The column is centered on the main area, not on the window, and is the 46 rem lane.
  expect(surface.left - region.left).toBeCloseTo(region.right - surface.right, 0);
  expect(surface.width).toBeCloseTo(46 * 16, 0);

  // It grows with the prompt, up to half the view.
  await userEvent.fill(
    promptField(),
    Array.from({ length: 40 }, (_unused, line) => `line ${line}`).join("\n"),
  );
  await expect
    .poll(() => promptField().element().getBoundingClientRect().height)
    .toBeLessThanOrEqual(region.height / 2 + 1);
  expect(promptField().element().getBoundingClientRect().height).toBeGreaterThan(prompt.height);
});

test("a prompt typed into the composer creates the task and its agent works on it", async () => {
  const { client } = await appWithProject(newClient());
  await prefixThen("t");
  await expect.element(promptField()).toHaveFocus();

  await pickAgent("pi");
  await promptField().click();
  // The prompt, then Enter. Shift+Enter would have added a newline instead.
  await userEvent.keyboard("Explain the build{Enter}");

  // The task is there at once under the server's seed title, its primary agent already working.
  await expect.element(taskButton("Explain the build")).toHaveAttribute("aria-current", "true");
  await expect.element(sessionTab("pi")).toHaveAttribute("aria-selected", "true");
  // No shell starts on its own.
  await expect.element(shellTabs()).toHaveLength(0);
  const task = client.tasks.getSnapshot().tasks[0]!;
  expect(task).toMatchObject({ prompt: "Explain the build", titleSource: "seed" });
  expect(task.primarySessionId).not.toBeNull();
  const session = client.sessions
    .getSnapshot()
    .sessions.find((candidate) => candidate.id === task.primarySessionId);
  expect(session).toMatchObject({ kind: "pi", view: "chat", terminalId: null });
  await expect
    .element(page.getByRole("log", { name: "Chat transcript" }))
    .toMatchTextContent("Explain the build");
});

test("each project's own defaults prefill the composer and name the agent the task starts", async () => {
  const { client, repo } = await appWithProject(newClient());
  const otherRepo = await createGitRepo("other");
  await client.connection.api.projects.add({ path: otherRepo });
  await vi.waitFor(() => expect(client.projects.getSnapshot().projects).toHaveLength(2));
  const [first, other] = [
    client.projects.getSnapshot().projects.find((project) => project.path === repo)!,
    client.projects.getSnapshot().projects.find((project) => project.path === otherRepo)!,
  ];

  // A global default and an override for the first project: the composer renders what A0 resolved.
  await writeConfig(
    `[tasks]\nview = "terminal"\nagent = "codex"\nworkspace = "new-worktree"\n\n[projects."${repo}"]\nagent = "pi"\n`,
  );
  await vi.waitFor(() =>
    expect(client.config.getSnapshot().config.projects[repo]?.agent.value).toBe("pi"),
  );

  await prefixThen("t");
  await userEvent.keyboard("Prefilled work");
  await expect.element(picker(/^Agent /)).toHaveAccessibleName("Agent pi · Agent default");
  await expect.element(picker(/^Workspace /)).toHaveAccessibleName("Workspace new worktree");
  await expect.element(page.getByText("defaults from project settings")).toBeVisible();

  // The other project has no entry of its own: the global section applies, and the line goes away.
  await userEvent.click(picker(/^Project /));
  await page.getByRole("option", { name: new RegExp(`^${other.name}`) }).click();
  await expect.element(picker(/^Project /)).toHaveAccessibleName(`Project ${other.name}`);
  await expect.element(picker(/^Agent /)).toHaveAccessibleName("Agent codex · Agent default");
  await expect.element(page.getByText("defaults from project settings")).not.toBeInTheDocument();

  // Back to the overridden project; the prompt the user typed survived both switches.
  await userEvent.click(picker(/^Project /));
  await page.getByRole("option", { name: new RegExp(`^${first.name}`) }).click();
  await expect.element(picker(/^Agent /)).toHaveAccessibleName("Agent pi · Agent default");
  await expect.element(promptField()).toHaveValue("Prefilled work");
  await userEvent.click(promptField());
  await userEvent.keyboard("{Enter}");

  await expect.element(taskButton("Prefilled work")).toHaveAttribute("aria-current", "true");
  const task = client.tasks.getSnapshot().tasks.find((each) => each.projectId === first.id)!;
  expect(task.ownsWorktree).toBe(true);
  expect(task.prompt).toBe("Prefilled work");
  await vi.waitFor(async () =>
    expect((await launchWithPrompt("Prefilled work"))?.agent).toBe("pi"),
  );
  await expect.element(shellTabs()).toHaveLength(0);

  // The config file is the server's for the whole suite: leave the other files their defaults.
  await writeConfig(null);
  await vi.waitFor(() => expect(client.config.getSnapshot().config.tasks.agent.value).toBeNull());
});

test("a project's chat view default opens the new task as chat", async () => {
  const { client, repo } = await appWithProject(newClient());
  const before = (await agentLaunches()).length;
  await writeConfig(`[projects."${repo}"]\nview = "chat"\n`);
  await vi.waitFor(() =>
    expect(client.config.getSnapshot().config.projects[repo]?.view.value).toBe("chat"),
  );

  await prefixThen("t");
  // Every agent in this build has a chat driver, so the configured view holds for each of them.
  await expect
    .element(newTaskView().getByRole("button", { name: "Open in chat" }))
    .toHaveAttribute("aria-pressed", "true");
  await pickAgent("codex");
  await expect
    .element(newTaskView().getByRole("button", { name: "Open in chat" }))
    .toHaveAttribute("aria-pressed", "true");
  await pickAgent("pi");
  await expect
    .element(newTaskView().getByRole("button", { name: "Open in chat" }))
    .toHaveAttribute("aria-pressed", "true");

  await userEvent.click(promptField());
  await userEvent.keyboard("Chat from the composer{Enter}");

  // The primary session opens as chat: pi's tab, the chat lane, and no terminal for it.
  await expect.element(sessionTab(/^pi/)).toHaveAttribute("aria-selected", "true");
  await expect.element(page.getByRole("log", { name: "Chat transcript" })).toBeVisible();
  await expect.element(page.getByRole("textbox", { name: "Message" })).toBeVisible();
  await vi.waitFor(async () => {
    const fresh = (await agentLaunches()).slice(before);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.agent).toBe("pi");
    expect(fresh[0]?.argv).toContain("rpc");
  });

  // The config file is the server's for the whole suite: leave the other files their defaults.
  await writeConfig(null);
  await vi.waitFor(() => expect(client.config.getSnapshot().config.projects[repo]).toBeUndefined());
});

test("a disabled agent disappears from the pickers and the task starts one still enabled", async () => {
  const { client } = await appWithProject(newClient());
  const before = (await agentLaunches()).length;
  await writeConfig("[agents.claude]\nenabled = false\n");
  await vi.waitFor(() =>
    expect(client.config.getSnapshot().config.agents.claude.enabled.value).toBe(false),
  );

  await prefixThen("t");
  // The default falls to the first agent still offered; claude is not in the list at all.
  await expect.element(picker(/^Agent /)).toHaveAccessibleName("Agent codex · Agent default");
  await userEvent.click(picker(/^Agent /));
  await expect.element(page.getByRole("radio", { name: /^claude/ })).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await userEvent.click(promptField());
  await userEvent.keyboard("Enabled agent only{Enter}");

  await vi.waitFor(async () => {
    const fresh = (await agentLaunches()).slice(before);
    expect(fresh.map((launch) => launch.agent)).toEqual(["codex"]);
  });

  await writeConfig(null);
  await vi.waitFor(() =>
    expect(client.config.getSnapshot().config.agents.claude.enabled.value).toBe(true),
  );
});

test("Escape leaves the composer and returns the keyboard to the task that was selected", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Back here");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await prefixThen("t");
  await expect.element(promptField()).toHaveFocus();
  await userEvent.keyboard("Not this one{Escape}");

  await expect.element(newTaskView()).not.toBeInTheDocument();
  await expect.element(taskHeader().getByRole("heading", { name: "Back here" })).toBeVisible();
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await userEvent.keyboard("echo back-$((2+2)){Enter}");
  await expect.poll(() => screenText()).toContain("back-4");
});

test("a branch taken since the list was read is refused by name and keeps the prompt", async () => {
  const { client } = await appWithProject(newClient(), ["feature/x", "free"]);
  await prefixThen("t");
  await openWorkspacePicker();
  // The main tree holds `main`, so only the free branches are offered.
  await expect.element(page.getByRole("option", { name: "feature/x" })).toBeVisible();
  await expect.element(page.getByRole("option", { name: "free" })).toBeVisible();
  await expect
    .element(page.getByRole("option", { name: "main", exact: true }))
    .not.toBeInTheDocument();
  await userEvent.keyboard("feature/x{Enter}");
  await expect.element(picker(/^Workspace /)).toHaveAccessibleName("Workspace feature/x");
  await userEvent.click(promptField());
  await userEvent.keyboard("Take the branch");

  // Another worktree takes the branch after this list was read, before the composer submits.
  const project = client.projects.getSnapshot().projects[0]!;
  const holder = await client.connection.api.tasks.create({
    projectId: project.id,
    title: "Branch holder",
    workspace: { type: "existing-branch", branch: "feature/x" },
  });

  await userEvent.click(promptField());
  await userEvent.keyboard("{Enter}");

  await expect
    .element(newTaskView().getByRole("alert"))
    .toMatchTextContent(
      `branch 'feature/x' is already checked out at ${holder.workspacePath}; choose another branch`,
    );
  await expect.element(promptField()).toHaveValue("Take the branch");
  expect(client.tasks.getSnapshot().tasks.some((task) => task.title === "Take the branch")).toBe(
    false,
  );

  // Escape is refused while the error is showing: leaving would throw the draft away, and
  // `ux.md` promises that a failed submission preserves its input.
  await userEvent.keyboard("{Escape}");
  await expect.element(newTaskView()).toBeVisible();
  await expect.element(newTaskView().getByRole("alert")).toBeVisible();
  await expect.element(promptField()).toHaveValue("Take the branch");

  // Fixing the workspace is enough: the same prompt now creates the task.
  await openWorkspacePicker();
  await userEvent.keyboard("new worktree{Enter}");
  await expect.element(picker(/^Workspace /)).toHaveAccessibleName("Workspace new worktree");
  await userEvent.click(promptField());
  await userEvent.keyboard("{Enter}");
  await expect.element(taskButton("Take the branch")).toHaveAttribute("aria-current", "true");
  const task = client.tasks
    .getSnapshot()
    .tasks.find((candidate) => candidate.title === "Take the branch");
  expect(task?.branch).not.toBe("feature/x");
});

test("a sidebar project pick keeps the draft and creates the task in the new project", async () => {
  // The default device preference groups tasks by project.
  window.localStorage.removeItem("corral.sidebar-mode");
  const { client } = await appWithProject(newClient(), ["feature/x"]);
  const otherRepo = await createGitRepo("other");
  await client.connection.api.projects.add({ path: otherRepo });
  await vi.waitFor(() => expect(client.projects.getSnapshot().projects).toHaveLength(2));
  const other = client.projects
    .getSnapshot()
    .projects.find((project) => project.path === otherRepo)!;
  const current = client.projects
    .getSnapshot()
    .projects.find((project) => project.path !== otherRepo)!;
  await expect
    .element(newTaskView().getByRole("combobox", { name: /^Project / }))
    .toHaveAccessibleName(`Project ${current.name}`);

  // A prompt and the current project's branch: both belong to the composer's draft now.
  await userEvent.keyboard("In the other repo");
  await openWorkspacePicker();
  await userEvent.keyboard("feature/x{Enter}");
  await expect.element(picker(/^Workspace /)).toHaveAccessibleName("Workspace feature/x");

  // Project mode lists the projects; the project's New task action opens it for the composer too.
  await workspace()
    .getByRole("button", { name: `New task in ${other.name}` })
    .click();

  await expect
    .element(newTaskView().getByRole("combobox", { name: /^Project / }))
    .toHaveAccessibleName(`Project ${other.name}`);
  // The remounted composer keeps the user's text, drops what only the old project owned, and
  // takes the keyboard back for the next thing the user types.
  await expect.element(promptField()).toHaveValue("In the other repo");
  await expect.element(picker(/^Workspace /)).toHaveAccessibleName("Workspace main tree");
  await expect.element(promptField()).toHaveFocus();

  await userEvent.keyboard("{Enter}");
  await expect.element(taskButton("In the other repo")).toHaveAttribute("aria-current", "true");
  const task = client.tasks.getSnapshot().tasks[0]!;
  expect(task.projectId).toBe(other.id);
  expect(task.workspacePath).toBe(other.path);
});

test("prefix t focuses the prompt of a composer that is open over a task", async () => {
  await appWithProject(newClient());
  await createTaskWithShell("Focus me");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await prefixThen("t");
  await expect.element(promptField()).toHaveFocus();
  // The keyboard is somewhere else while the composer stays open over the task.
  workspace().getByRole("button", { name: "Search tasks" }).element().focus();
  await expect.element(promptField()).not.toHaveFocus();

  await prefixThen("t");
  await expect.element(promptField()).toHaveFocus();
  await userEvent.keyboard("typedafterthekey");
  await expect.element(promptField()).toHaveValue("typedafterthekey");
});

test("prefix t hands the keyboard back to an already-open composer", async () => {
  await appWithProject(newClient());
  await expect.element(promptField()).toHaveFocus();

  // The keyboard is somewhere else - the sidebar's search button - and the composer is still open.
  workspace().getByRole("button", { name: "Search tasks" }).element().focus();
  await expect.element(promptField()).not.toHaveFocus();

  await prefixThen("t");
  await expect.element(promptField()).toHaveFocus();
  await userEvent.keyboard("typedafterthekey");
  await expect.element(promptField()).toHaveValue("typedafterthekey");
});
