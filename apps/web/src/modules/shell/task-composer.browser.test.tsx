import type { CorralClient } from "@corral/client/corral-client";
import type { Project, Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { writeConfig } from "../../../test/config-command.ts";
import { agentLaunches } from "../../../test/fake-agents.ts";
import { removeDirectoryIn } from "../../../test/files-client.ts";
import { createGitRepo } from "../../../test/git-repo.ts";
import { runGitIn } from "../../../test/git-client.ts";
import { prefixThen, realServerClients } from "../../../test/real-client.ts";
import { renderApp } from "../../../test/render-app.tsx";

const { newClient } = realServerClients();

const composer = () => page.getByRole("form", { name: "New task" });
const promptField = () => composer().getByRole("textbox", { name: "Prompt" });
const createButton = () => composer().getByRole("button", { name: /Create task|Creating task/ });
const projectChoice = () => page.getByRole("dialog", { name: "New task" });
const newTaskButton = () => page.getByRole("button", { name: "New task" });
const projectButton = () => composer().getByRole("combobox", { name: /^Project / });

async function connected(client: CorralClient) {
  await expect.poll(() => client.connection.state.getSnapshot().status).toBe("connected");
}

async function appWithProject(name: string) {
  const repo = await createGitRepo(name);
  const client = newClient();
  await connected(client);
  const project = await client.connection.api.projects.add({ path: repo });
  const screen = await renderApp(client);
  await expect.poll(() => client.projects.getSnapshot().loaded).toBe(true);
  await expect.poll(() => client.tasks.getSnapshot().loaded).toBe(true);
  return { client, project, repo, screen };
}

async function selectOption(triggerName: string | RegExp, optionName: string | RegExp) {
  await page.getByRole("combobox", { name: triggerName }).click();
  await page.getByRole("option", { name: optionName }).click();
}

async function createTaskThroughApi(client: CorralClient, project: Project): Promise<Task> {
  return client.connection.api.tasks.create({
    projectId: project.id,
    title: "Anchor task",
    workspace: { type: "main-worktree" },
  });
}

const ctrl = (key: string) => userEvent.keyboard(`{Control>}${key}{/Control}`);
const ctrlShift = (key: string) => userEvent.keyboard(`{Control>}{Shift>}${key}{/Shift}{/Control}`);
const ctrlAlt = (key: string) => userEvent.keyboard(`{Control>}{Alt>}${key}{/Alt}{/Control}`);

test("the New task button creates a project task through the real server and selects it", async () => {
  const { client, project, repo, screen } = await appWithProject("composer-project");
  const before = (await runGitIn(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();

  // One project is enough: the accepted pointer flow does not ask a question with one answer.
  await newTaskButton().click();
  await expect.element(composer()).toBeVisible();
  await expect.element(projectChoice()).not.toBeInTheDocument();
  await expect.element(promptField()).toHaveFocus();
  await expect.element(projectButton()).toHaveTextContent(project.name);

  const prompt = "Summarise the widget parser";
  await promptField().fill(prompt);
  await createButton().click();

  const task = await vi.waitFor(() => {
    const found = client.tasks.getSnapshot().tasks.find((candidate) => candidate.prompt === prompt);
    if (found === undefined) throw new Error("the task is not in the store yet");
    return found;
  });
  expect(task.projectId).toBe(project.id);
  expect(task.branch).toBe("main");
  expect((await runGitIn(repo, ["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe(before);

  await expect.element(page.getByRole("heading", { name: task.title })).toBeVisible();
  const eyebrow = screen.container.querySelector(".visual-main-eyebrow")?.textContent ?? "";
  expect(eyebrow).toContain("recorded");
  expect(eyebrow).toContain("main");
  expect(page.getByRole("button", { name: /branch/i }).elements()).toHaveLength(0);
  await screen.unmount();
});

test("a pointer-created scratch task has no project, no Git controls and its own row", async () => {
  const { client, screen } = await appWithProject("composer-scratch");
  await newTaskButton().click();
  await expect.element(composer()).toBeVisible();

  await selectOption(/^Project /, /No project/);
  await expect.element(composer().getByText("Scratch workspace · no Git controls")).toBeVisible();
  await expect.element(promptField()).toHaveFocus();
  await expect
    .element(composer().getByRole("button", { name: /Workspace/ }))
    .not.toBeInTheDocument();

  const prompt = "Sketch a release checklist";
  await promptField().fill(prompt);
  await createButton().click();

  const task = await vi.waitFor(() => {
    const found = client.tasks.getSnapshot().tasks.find((candidate) => candidate.prompt === prompt);
    if (found === undefined) throw new Error("the scratch task is not in the store yet");
    return found;
  });
  expect(task.projectId).toBeNull();
  expect(task.branch).toBeNull();
  expect(task.primarySessionId).not.toBeNull();
  expect(
    client.sessions.getSnapshot().sessions.some((session) => session.id === task.primarySessionId),
  ).toBe(true);
  await expect.element(page.getByRole("heading", { name: task.title })).toBeVisible();
  const eyebrow = screen.container.querySelector(".visual-main-eyebrow")?.textContent ?? "";
  expect(eyebrow).toContain("No project");
  expect(eyebrow).not.toContain("recorded");
  await expect.element(newTaskButton()).toBeVisible();
  await screen.unmount();
});

test("Mod+N skips project selection with one project; prefix new-task still works", async () => {
  const { client, project, screen } = await appWithProject("composer-direct-new");
  await ctrl("n");
  await expect.element(composer()).toBeVisible();
  await expect.element(projectChoice()).not.toBeInTheDocument();
  await expect.element(projectButton()).toHaveTextContent(project.name);
  await expect.element(promptField()).toHaveFocus();

  await userEvent.keyboard("{Escape}");
  await expect.element(composer()).not.toBeInTheDocument();

  await prefixThen("t");
  await expect.element(composer()).toBeVisible();
  await expect.element(projectButton()).toHaveTextContent(project.name);

  // Opening drafts created nothing.
  expect(client.tasks.getSnapshot().tasks).toHaveLength(0);
  await screen.unmount();
});

test("a configured direct chord replaces the default in the shell", async () => {
  await writeConfig('[keys.direct]\nnew-task = "ctrl+shift+j"\n');
  const { client, project, screen } = await appWithProject("composer-direct-config");
  await expect
    .poll(() => client.config.getSnapshot().config.keys.direct["new-task"])
    .toBe("ctrl+shift+j");

  await ctrlShift("j");
  await expect.element(composer()).toBeVisible();
  await expect.element(projectButton()).toHaveTextContent(project.name);
  await userEvent.keyboard("{Escape}");

  // The old default no longer opens a draft.
  await ctrl("n");
  await expect.element(composer()).not.toBeInTheDocument();
  await screen.unmount();
});

test("Mod+Shift+N drafts in the current project, and without one it asks instead of guessing", async () => {
  const { client, project, screen } = await appWithProject("composer-direct-current");
  const anchor = await createTaskThroughApi(client, project);

  // The shell must be told which task is current; a fresh app restores it from the route.
  await screen.unmount();
  const second = await renderApp(client, [`/?task=${anchor.id}`]);
  await ctrlShift("n");
  await expect.element(composer()).toBeVisible();
  await expect.element(projectButton()).toHaveTextContent(project.name);
  await userEvent.keyboard("{Escape}");

  // No selection: the current-project command must ask, even with exactly one project.
  await second.unmount();
  const third = await renderApp(client, ["/?task=none"]);
  await ctrlShift("n");
  await expect.element(projectChoice()).toBeVisible();
  await expect.element(composer()).not.toBeInTheDocument();
  await page.getByRole("button", { name: project.name }).click();
  await expect.element(composer()).toBeVisible();
  await expect.element(projectButton()).toHaveTextContent(project.name);
  await third.unmount();
});

test("Mod+Alt+N drafts without a project on an install that has one", async () => {
  const { screen } = await appWithProject("composer-direct-scratch");
  await ctrlAlt("n");
  await expect.element(composer()).toBeVisible();
  await expect.element(projectButton()).toHaveTextContent("No project");
  await expect.element(composer().getByText("Scratch workspace · no Git controls")).toBeVisible();
  await screen.unmount();
});

test("opening a draft creates no task and launches no agent", async () => {
  const { client, project, screen } = await appWithProject("composer-draft-no-write");
  const anchor = await createTaskThroughApi(client, project);
  await screen.unmount();
  const second = await renderApp(client, [`/?task=${anchor.id}`]);
  const tasksBefore = client.tasks.getSnapshot().tasks.length;
  const launchesBefore = (await agentLaunches()).length;

  await ctrlShift("n");
  await expect.element(composer()).toBeVisible();
  await promptField().fill("Draft only, do not start");
  await expect.element(promptField()).toHaveValue("Draft only, do not start");

  expect(client.tasks.getSnapshot().tasks).toHaveLength(tasksBefore);
  expect(await agentLaunches()).toHaveLength(launchesBefore);
  await second.unmount();
});

test("a cancelled picker and a failed create keep the prompt and its focus", async () => {
  const { client, project, repo, screen } = await appWithProject("composer-preserve");
  const anchor = await createTaskThroughApi(client, project);
  await screen.unmount();
  const second = await renderApp(client, [`/?task=${anchor.id}`]);

  await ctrlShift("n");
  await expect.element(promptField()).toHaveFocus();
  const prompt = "Keep this prompt through every failure";
  await promptField().fill(prompt);

  await composer()
    .getByRole("button", { name: /^Agent / })
    .click();
  await expect.element(page.getByRole("dialog", { name: "Agent and model" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect
    .element(page.getByRole("dialog", { name: "Agent and model" }))
    .not.toBeInTheDocument();
  await expect.element(promptField()).toHaveValue(prompt);
  await expect.element(promptField()).toHaveFocus();

  // A real server refusal: the project's repository disappears before a new-worktree create.
  await selectOption("Workspace Main worktree", "New worktree");
  await removeDirectoryIn(repo);
  await createButton().click();
  await expect.element(composer().getByRole("alert")).toBeVisible();
  await expect.element(promptField()).toHaveValue(prompt);
  expect(client.tasks.getSnapshot().tasks.some((task) => task.prompt === prompt)).toBe(false);
  await second.unmount();
});

test("an empty install reaches a scratch draft without inventing a project", async () => {
  const client = newClient();
  await connected(client);
  const screen = await renderApp(client);
  await expect.poll(() => client.projects.getSnapshot().loaded).toBe(true);

  await newTaskButton().click();
  await expect.element(projectChoice()).toBeVisible();
  await page.getByRole("button", { name: "No project" }).click();
  await expect.element(composer()).toBeVisible();
  await expect.element(projectButton()).toHaveTextContent("No project");
  await screen.unmount();
});

test("Settings opens the existing screen over the shell and returns to the draft", async () => {
  const { screen } = await appWithProject("composer-settings");
  await ctrl("n");
  await promptField().fill("Keep this across Settings");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect.element(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Back to workspace" }).click();
  await expect.element(composer()).toBeVisible();
  await expect.element(promptField()).toHaveValue("Keep this across Settings");
  await screen.unmount();
});

test("a disabled instance is filtered from new choices and invalidates the current pick", async () => {
  await writeConfig('[tasks]\nagent = "pi"\nview = "terminal"\n[agents.pi]\nenabled = true\n');
  const { client, screen } = await appWithProject("composer-disabled-instance");
  await expect.poll(() => client.config.getSnapshot().config.tasks.agent.value).toBe("pi");

  await ctrl("n");
  await expect.element(composer()).toBeVisible();
  await composer()
    .getByRole("button", { name: /^Agent pi/ })
    .click();
  const rail = page.getByRole("listbox", { name: "agent" });
  await expect.element(rail.getByRole("option", { name: "pi" })).toBeVisible();
  await userEvent.keyboard("{Escape}");

  await writeConfig('[tasks]\nagent = "pi"\nview = "terminal"\n[agents.pi]\nenabled = false\n');
  await expect.poll(() => client.config.getSnapshot().config.agents.pi.enabled.value).toBe(false);
  await expect
    .element(composer().getByRole("alert"))
    .toHaveTextContent("The pi agent is disabled in the config file. Choose another agent.");

  await promptField().fill("This cannot start the disabled agent");
  await expect.element(createButton()).toBeDisabled();
  await composer()
    .getByRole("button", { name: /^Agent pi/ })
    .click();
  await expect
    .element(page.getByRole("listbox", { name: "agent" }).getByRole("option", { name: "pi" }))
    .not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await screen.unmount();
});
