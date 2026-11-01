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

const picker = (name: RegExp) => newTaskView().getByRole("combobox", { name });

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

  // `layout.md` **New task view**: about a third of the height, four lines at rest.
  expect(prompt.top).toBeGreaterThan(region.height * 0.28);
  expect(prompt.top).toBeLessThan(region.height * 0.4);
  expect(prompt.height).toBeGreaterThanOrEqual(80);
  // The column is centered on the main area, not on the window, and is the 46 rem lane.
  expect(prompt.left - region.left).toBeCloseTo(region.right - prompt.right, 0);
  expect(prompt.width).toBeCloseTo(46 * 16, 0);

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

  // Keyboard only: the prompt, then Enter. Shift+Enter would have added a newline instead.
  await userEvent.keyboard("Explain the build{Enter}");

  // The task is there at once under the server's seed title, its primary agent already working.
  await expect.element(taskButton("Explain the build")).toHaveAttribute("aria-current", "true");
  await expect.element(sessionTab("claude")).toHaveAttribute("aria-selected", "true");
  // No shell starts on its own.
  await expect.element(shellTabs()).toHaveLength(0);
  const task = client.tasks.getSnapshot().tasks[0]!;
  expect(task).toMatchObject({ prompt: "Explain the build", titleSource: "seed" });
  expect(task.primarySessionId).not.toBeNull();
  const launch = await vi.waitFor(async () => {
    const found = await launchWithPrompt("Explain the build");
    if (found === undefined) throw new Error("the agent has not been launched with the prompt");
    return found;
  });
  expect(launch.agent).toBe("claude");
  expect(launch.env.CORRAL_TASK_ID).toBe(task.id);
  await expect.poll(() => screenText()).toContain("fake claude ready");
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
    `[tasks]\nagent = "codex"\nworkspace = "new-worktree"\n\n[projects."${repo}"]\nagent = "pi"\n`,
  );
  await vi.waitFor(() =>
    expect(client.config.getSnapshot().config.projects[repo]?.agent.value).toBe("pi"),
  );

  await prefixThen("t");
  await userEvent.keyboard("Prefilled work");
  await expect.element(picker(/^Agent /)).toHaveAccessibleName("Agent pi · native default");
  await expect.element(picker(/^Workspace /)).toHaveAccessibleName("Workspace new worktree");
  await expect.element(page.getByText("defaults from project settings")).toBeVisible();

  // The other project has no entry of its own: the global section applies, and the line goes away.
  await userEvent.click(picker(/^Project /));
  await page.getByRole("option", { name: new RegExp(`^${other.name}`) }).click();
  await expect.element(picker(/^Project /)).toHaveAccessibleName(`Project ${other.name}`);
  await expect.element(picker(/^Agent /)).toHaveAccessibleName("Agent codex · native default");
  await expect.element(page.getByText("defaults from project settings")).not.toBeInTheDocument();

  // Back to the overridden project; the prompt the user typed survived both switches.
  await userEvent.click(picker(/^Project /));
  await page.getByRole("option", { name: new RegExp(`^${first.name}`) }).click();
  await expect.element(picker(/^Agent /)).toHaveAccessibleName("Agent pi · native default");
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
  // The configured view needs a driver: with an agent that has one it is chat, and picking codex
  // (no driver in this build) reads as the terminal — the composer never offers a view the server
  // would refuse. Picking pi again restores the configured view.
  await expect.element(picker(/^View /)).toHaveAccessibleName("View chat");
  await userEvent.click(picker(/^Agent /));
  await page.getByRole("option", { name: /^codex/ }).click();
  await expect.element(picker(/^View /)).toHaveAccessibleName("View terminal");
  await expect.element(page.getByText(/needs an agent with a chat driver/)).toBeVisible();
  await userEvent.click(picker(/^Agent /));
  await page.getByRole("option", { name: /^pi/ }).click();
  await expect.element(picker(/^View /)).toHaveAccessibleName("View chat");

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
  await expect.element(picker(/^Agent /)).toHaveAccessibleName("Agent codex · native default");
  await userEvent.click(picker(/^Agent /));
  await expect.element(page.getByRole("option", { name: /^claude/ })).not.toBeInTheDocument();
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

test("git's refusal stays in the composer and keeps the prompt", async () => {
  const { client } = await appWithProject(newClient(), ["feature/x"]);
  await prefixThen("t");
  await userEvent.keyboard("Take the branch");
  await openWorkspacePicker();
  await userEvent.keyboard("feature/x{Enter}");
  await expect.element(picker(/^Workspace /)).toHaveAccessibleName("Workspace feature/x");
  await userEvent.click(promptField());
  await userEvent.keyboard("{Enter}");
  await expect.element(taskButton("Take the branch")).toHaveAttribute("aria-current", "true");
  const first = client.tasks.getSnapshot().tasks[0]!;
  expect(first.branch).toBe("feature/x");

  // The same branch cannot be checked out in a second worktree; git's own words come back.
  await prefixThen("t");
  await userEvent.keyboard("Second try");
  await openWorkspacePicker();
  await userEvent.keyboard("feature/x{Enter}");
  await userEvent.click(promptField());
  await userEvent.keyboard("{Enter}");

  await expect
    .element(newTaskView().getByRole("alert"))
    .toMatchTextContent(/already used by worktree/);
  await expect.element(promptField()).toHaveValue("Second try");
  expect(client.tasks.getSnapshot().tasks).toHaveLength(1);

  // Escape is refused while the error is showing: leaving would throw the draft away, and
  // `ux.md` promises that a failed submission preserves its input.
  await userEvent.keyboard("{Escape}");
  await expect.element(newTaskView()).toBeVisible();
  await expect.element(newTaskView().getByRole("alert")).toBeVisible();
  await expect.element(promptField()).toHaveValue("Second try");

  // Fixing the workspace is enough: the same prompt now creates the task.
  await openWorkspacePicker();
  await userEvent.keyboard("new worktree{Enter}");
  await expect.element(picker(/^Workspace /)).toHaveAccessibleName("Workspace new worktree");
  await userEvent.click(promptField());
  await userEvent.keyboard("{Enter}");
  await expect.element(taskButton("Second try")).toHaveAttribute("aria-current", "true");
  const tasks = client.tasks.getSnapshot().tasks;
  expect(tasks).toHaveLength(2);
  expect(tasks.find((task) => task.title === "Second try")?.branch).not.toBe("feature/x");
});

test("a sidebar project pick keeps the draft and creates the task in the new project", async () => {
  // Another file may have left this device in project mode; the default is flat.
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

  // Project mode lists the projects; selecting one selects it for the composer too.
  await prefixThen("l");
  await workspace().getByRole("button", { name: other.name, exact: true }).click();

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
