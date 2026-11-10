import type { CorralClient } from "@corral/client/corral-client";
import type { Project, Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { writeConfig } from "../../../test/config-command.ts";
import { agentLaunches } from "../../../test/fake-agents.ts";
import { removeDirectoryIn, writeFilesIn } from "../../../test/files-client.ts";
import { createGitRepo, createGitRepoWithRemote } from "../../../test/git-repo.ts";
import { runGitIn } from "../../../test/git-client.ts";
import { prefixThen, realServerClients } from "../../../test/real-client.ts";
import { renderApp } from "../../../test/render-app.tsx";

const { newClient } = realServerClients();

const composer = () => page.getByRole("form", { name: "New task" });
const promptField = () => composer().getByRole("textbox", { name: "Prompt" });
const createButton = () => composer().getByRole("button", { name: /Create task|Creating task/ });
const projectChoice = () => page.getByRole("dialog", { name: "New task" });
const newTaskButton = () => page.getByRole("button", { name: "New task" });
const projectButton = () => composer().getByRole("button", { name: /^Project / });
const workspaceButton = (name: string) =>
  composer().getByRole("combobox", { name: `Workspace ${name}` });
const branchButton = (name: string) =>
  composer().getByRole("combobox", { name: `Base branch ${name}` });
const checkoutRowBranch = () => composer().element().querySelector(".task-composer-branch");

async function connected(client: CorralClient) {
  await expect.poll(() => client.connection.state.getSnapshot().status).toBe("connected");
}

async function appWithProject(name: string, branches: string[] = []) {
  const repo = await createGitRepo(name, branches);
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

/** Tailwind composes a zero-alpha shadow chain even without a ring, so a ring shows as a layer
 * that is not fully transparent. */
function visibleShadow(value: string) {
  return value === "none"
    ? ""
    : value.replaceAll(/rgba\(0, 0, 0, 0\)|0px 0px 0px 0px|,/g, "").trim();
}

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

test("choosing a project in the first picker puts the keyboard in the prompt", async () => {
  const { client, project, screen } = await appWithProject("composer-first-choice");
  const secondRepo = await createGitRepo("composer-first-choice-two");
  const second = await client.connection.api.projects.add({ path: secondRepo });
  await vi.waitFor(() =>
    expect(client.projects.getSnapshot().projects.some((each) => each.id === second.id)).toBe(true),
  );

  // Pointer: the chosen project's draft owns the keyboard, not the sidebar button that opened it.
  await newTaskButton().click();
  await expect.element(projectChoice()).toBeVisible();
  await page.getByRole("option", { name: project.name, exact: true }).click();
  await expect.element(projectChoice()).not.toBeInTheDocument();
  await expect.element(promptField()).toHaveFocus();
  await userEvent.keyboard("Typed straight after the picker");
  await expect.element(promptField()).toHaveValue("Typed straight after the picker");

  // Keyboard: ArrowDown and Enter choose the first row, and the prompt takes the same keyboard.
  await userEvent.keyboard("{Escape}");
  await expect.element(composer()).not.toBeInTheDocument();
  await newTaskButton().click();
  await expect.element(page.getByRole("combobox", { name: "Search projects" })).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}{Enter}");
  await expect.element(projectChoice()).not.toBeInTheDocument();
  await expect.element(promptField()).toHaveFocus();
  await screen.unmount();
});

test("a cancelled first picker returns the keyboard to the New task button", async () => {
  const { client, screen } = await appWithProject("composer-first-cancel");
  const secondRepo = await createGitRepo("composer-first-cancel-two");
  const second = await client.connection.api.projects.add({ path: secondRepo });
  await vi.waitFor(() =>
    expect(client.projects.getSnapshot().projects.some((each) => each.id === second.id)).toBe(true),
  );

  await newTaskButton().click();
  await expect.element(projectChoice()).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(projectChoice()).not.toBeInTheDocument();
  await expect.element(composer()).not.toBeInTheDocument();
  await expect.element(newTaskButton()).toHaveFocus();
  await screen.unmount();
});

test("the prompt has no focus ring and cannot be resized by dragging", async () => {
  const { screen } = await appWithProject("composer-prompt-chrome");
  await ctrl("n");
  await expect.element(promptField()).toHaveFocus();

  // Tailwind composes a zero-alpha shadow chain even without a ring, so a ring shows as a layer
  // that is not fully transparent.
  const field = promptField().element();
  const style = getComputedStyle(field);
  expect(style.resize).toBe("none");
  expect(style.outlineStyle).toBe("none");
  expect(visibleShadow(style.boxShadow)).toBe("");
  // The composer inset (`ui-kit.md`, **Input padding**), not a class string.
  expect(style.paddingLeft).toBe("16px");
  expect(style.paddingRight).toBe("16px");
  expect(style.paddingTop).toBe("12px");
  expect(style.paddingBottom).toBe("12px");

  const surface = composer().element().querySelector('[data-slot="composer-surface"]');
  if (!(surface instanceof HTMLElement)) throw new Error("the composer has no surface");
  expect(visibleShadow(getComputedStyle(surface).boxShadow)).toBe("");
  await screen.unmount();
});

test("Escape closes a context picker without leaving the draft", async () => {
  const { screen } = await appWithProject("composer-context-escape");
  await ctrl("n");
  await workspaceButton("Current checkout").click();
  await expect.element(page.getByRole("option", { name: "New worktree" })).toBeVisible();

  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("option", { name: "New worktree" })).not.toBeInTheDocument();
  await expect.element(composer()).toBeVisible();
  await screen.unmount();
});

test("the project name opens the shared project picker and returns focus to the prompt", async () => {
  const { project, screen } = await appWithProject("composer-project-picker");
  await ctrl("n");
  await promptField().fill("Keep this draft");

  await projectButton().click();
  await expect.element(projectChoice()).toBeVisible();
  await expect.element(page.getByRole("combobox", { name: "Search projects" })).toHaveFocus();
  await expect.element(page.getByRole("button", { name: `Pin ${project.name}` })).toBeVisible();

  await page.getByRole("option", { name: project.name, exact: true }).click();
  await expect.element(projectChoice()).not.toBeInTheDocument();
  await expect.element(promptField()).toHaveFocus();
  await expect.element(promptField()).toHaveValue("Keep this draft");
  await screen.unmount();
});

test("Current checkout switches to a new worktree and sends the chosen base branch", async () => {
  const { client, project, repo, screen } = await appWithProject("composer-base-branch", [
    "feature/x",
  ]);
  await runGitIn(repo, ["checkout", "feature/x"]);
  await runGitIn(repo, ["commit", "--allow-empty", "-m", "feature base"]);
  await runGitIn(repo, ["checkout", "main"]);

  await ctrl("n");
  await expect.element(promptField()).toHaveFocus();

  const context = composer().element().querySelector(".task-composer-context");
  if (!(context instanceof HTMLElement)) throw new Error("the composer has no context row");
  expect(context.textContent).toContain(project.name);
  expect(context.textContent).toContain("Current checkout");
  expect(context.querySelector(".task-composer-branch")?.textContent).toBe("main");
  expect(context.textContent).not.toContain(project.path);
  expect(getComputedStyle(context).flexWrap).toBe("nowrap");

  await workspaceButton("Current checkout").click();
  await expect.element(page.getByRole("option", { name: "Current checkout" })).toBeVisible();
  await expect.element(page.getByRole("option", { name: "New worktree" })).toBeVisible();
  expect(page.getByRole("option").elements()).toHaveLength(2);
  await page.getByRole("option", { name: "New worktree" }).click();

  await expect.element(branchButton("main")).toBeVisible();
  await expect.element(composer().getByText("from main", { exact: true })).toBeVisible();

  await branchButton("main").click();
  const search = page.getByRole("combobox", { name: "Search branches" });
  await expect.element(search).toBeVisible();
  await expect.element(search).toHaveFocus();
  await expect.element(page.getByRole("option", { name: "main" })).toBeVisible();
  await expect
    .element(page.getByRole("option", { name: "main" }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(page.getByRole("option", { name: "feature/x" })).toBeVisible();

  // The current base is the first row, so Enter confirms it instead of taking the first ref.
  await userEvent.keyboard("{Enter}");
  await expect.element(search).not.toBeInTheDocument();
  await expect.element(branchButton("main")).toBeVisible();
  await expect.element(composer().getByText("from main", { exact: true })).toBeVisible();

  await branchButton("main").click();
  await expect.element(search).toBeVisible();
  await expect.element(search).toHaveFocus();
  await userEvent.fill(search, "feat");
  await expect.element(page.getByRole("option", { name: "feature/x" })).toBeVisible();
  await expect.element(page.getByRole("option", { name: "main" })).not.toBeInTheDocument();
  await page.getByRole("option", { name: "feature/x" }).click();

  await expect.element(branchButton("feature/x")).toBeVisible();
  await expect.element(composer().getByText("from feature/x", { exact: true })).toBeVisible();

  // The worktree base is not the checkout fact: switching back shows what is checked out and
  // keeps the base for the next switch to a new worktree.
  await workspaceButton("New worktree").click();
  await page.getByRole("option", { name: "Current checkout" }).click();
  await vi.waitFor(() => expect(checkoutRowBranch()?.textContent).toBe("main"));
  expect(composer().element().textContent).not.toContain("from feature/x");

  await workspaceButton("Current checkout").click();
  await page.getByRole("option", { name: "New worktree" }).click();
  await expect.element(branchButton("feature/x")).toBeVisible();

  const prompt = "Start from the feature branch";
  await promptField().fill(prompt);
  await createButton().click();

  const task = await vi.waitFor(() => {
    const found = client.tasks.getSnapshot().tasks.find((candidate) => candidate.prompt === prompt);
    if (found === undefined) throw new Error("the task is not in the store yet");
    return found;
  });
  expect(task.branch).not.toBe("main");
  expect(task.workspacePath).not.toBe(repo);
  expect((await runGitIn(task.workspacePath, ["log", "-1", "--format=%s"])).trim()).toBe(
    "feature base",
  );
  await screen.unmount();
});

test("a branch another worktree holds is offered as a base and the task starts from it", async () => {
  const { client, repo, screen } = await appWithProject("composer-held-base", ["feature/held"]);
  await runGitIn(repo, ["checkout", "feature/held"]);
  await writeFilesIn(repo, { "held.txt": "held\n" });
  await runGitIn(repo, ["add", "held.txt"]);
  await runGitIn(repo, ["commit", "-m", "held base"]);
  await runGitIn(repo, ["checkout", "main"]);
  const held = `${repo}-held`;
  await runGitIn(repo, ["worktree", "add", held, "feature/held"]);

  await ctrl("n");
  await workspaceButton("Current checkout").click();
  await page.getByRole("option", { name: "New worktree" }).click();
  await branchButton("main").click();
  const search = page.getByRole("combobox", { name: "Search branches" });
  await userEvent.fill(search, "held");
  await expect.element(page.getByRole("option", { name: "feature/held" })).toBeVisible();
  await page.getByRole("option", { name: "feature/held" }).click();
  await expect.element(branchButton("feature/held")).toBeVisible();

  const prompt = "Start from the held branch";
  await promptField().fill(prompt);
  await createButton().click();
  const task = await vi.waitFor(() => {
    const found = client.tasks.getSnapshot().tasks.find((candidate) => candidate.prompt === prompt);
    if (found === undefined) throw new Error("the task is not in the store yet");
    return found;
  });
  expect((await runGitIn(task.workspacePath, ["rev-parse", "HEAD"])).trim()).toBe(
    (await runGitIn(held, ["rev-parse", "HEAD"])).trim(),
  );
  expect((await runGitIn(task.workspacePath, ["log", "-1", "--format=%s"])).trim()).toBe(
    "held base",
  );
  await screen.unmount();
});

test("a pointer-created scratch task has no project, no Git controls and its own row", async () => {
  const { client, screen } = await appWithProject("composer-scratch");
  await newTaskButton().click();
  await expect.element(composer()).toBeVisible();

  // The trigger names the project with the folder glyph; No project uses the picker's own glyph.
  const glyph = () => projectButton().element().querySelector("svg");
  expect(glyph()?.classList.contains("lucide-folder")).toBe(true);

  await projectButton().click();
  await page.getByRole("option", { name: "No project" }).click();
  await expect.element(projectButton()).toHaveTextContent("No project");
  expect(glyph()?.classList.contains("lucide-message-square-dashed")).toBe(true);
  expect(glyph()?.classList.contains("lucide-folder")).toBe(false);
  await expect.element(promptField()).toHaveFocus();
  await expect
    .element(composer().getByRole("button", { name: /Workspace/ }))
    .not.toBeInTheDocument();
  await expect.element(composer().getByText(/Scratch workspace/)).not.toBeInTheDocument();

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

test("a remote-only base is tagged remote and starts the task from it", async () => {
  const { repo } = await createGitRepoWithRemote("composer-remote-base");
  const client = newClient();
  await connected(client);
  await client.connection.api.projects.add({ path: repo });
  await writeFilesIn(repo, { "remote.txt": "remote\n" });
  await runGitIn(repo, ["add", "remote.txt"]);
  await runGitIn(repo, ["commit", "-m", "remote base"]);
  await runGitIn(repo, ["push", "origin", "HEAD:refs/heads/remote-base"]);
  await runGitIn(repo, ["fetch", "origin"]);
  await writeFilesIn(repo, { "local.txt": "local\n" });
  await runGitIn(repo, ["add", "local.txt"]);
  await runGitIn(repo, ["commit", "-m", "local head"]);
  const remoteHead = (await runGitIn(repo, ["rev-parse", "origin/remote-base"])).trim();

  const screen = await renderApp(client);
  await expect.poll(() => client.projects.getSnapshot().loaded).toBe(true);
  await ctrl("n");
  await workspaceButton("Current checkout").click();
  await page.getByRole("option", { name: "New worktree" }).click();
  await branchButton("main").click();
  const search = page.getByRole("combobox", { name: "Search branches" });
  await userEvent.fill(search, "remote-base");
  const option = page.getByRole("option", { name: /origin\/remote-base/ });
  await expect.element(option).toBeVisible();
  expect(option.element().textContent).toContain("remote");
  await option.click();
  await expect.element(branchButton("origin/remote-base")).toBeVisible();

  const prompt = "Start from the remote-only base";
  await promptField().fill(prompt);
  await createButton().click();
  const task = await vi.waitFor(() => {
    const found = client.tasks.getSnapshot().tasks.find((candidate) => candidate.prompt === prompt);
    if (found === undefined) throw new Error("the task is not in the store yet");
    return found;
  });
  expect((await runGitIn(task.workspacePath, ["rev-parse", "HEAD"])).trim()).toBe(remoteHead);
  expect((await runGitIn(task.workspacePath, ["log", "-1", "--format=%s"])).trim()).toBe(
    "remote base",
  );
  await screen.unmount();
});

test("Current checkout names the main tree's branch, not the stored default base", async () => {
  const client = newClient();
  await connected(client);
  const repo = await createGitRepo("composer-checkout-fact");
  const project = await client.connection.api.projects.add({ path: repo });
  await runGitIn(repo, ["switch", "-c", "side"]);

  const screen = await renderApp(client);
  await expect.poll(() => client.projects.getSnapshot().loaded).toBe(true);
  await ctrl("n");
  await vi.waitFor(() => expect(checkoutRowBranch()?.textContent).toBe("side"));
  expect(project.defaultBaseBranch).toBe("main");
  expect(checkoutRowBranch()?.textContent).not.toBe(project.defaultBaseBranch);
  await screen.unmount();
});

test("Current checkout shows HEAD when detached and no row when the read fails", async () => {
  const client = newClient();
  await connected(client);
  const repo = await createGitRepo("composer-checkout-detached");
  await client.connection.api.projects.add({ path: repo });
  await runGitIn(repo, ["checkout", "--detach"]);

  const screen = await renderApp(client);
  await expect.poll(() => client.projects.getSnapshot().loaded).toBe(true);
  await ctrl("n");
  await vi.waitFor(() => expect(checkoutRowBranch()?.textContent).toBe("HEAD"));

  // A repository gone behind the project is a failed read, not a detached checkout.
  await removeDirectoryIn(repo);
  await userEvent.keyboard("{Escape}");
  await expect.element(composer()).not.toBeInTheDocument();
  await ctrl("n");
  await expect.element(composer().getByRole("alert")).toBeVisible();
  expect(checkoutRowBranch()).toBeNull();
  await screen.unmount();
});

test("a refused configured profile is named from the config problem, not silently replaced", async () => {
  await writeConfig(
    '[tasks]\nagent = "pi"\nprofile = "gateway"\n\n[profiles.gateway]\nname = "Gateway"\nagent = "pi"\nmodel = "stub-1"\nenabled = false\n',
  );
  const { client, screen } = await appWithProject("composer-refused-profile");
  await expect
    .poll(() =>
      client.config.getSnapshot().problems.some((problem) => problem.path === "tasks.profile"),
    )
    .toBe(true);

  await ctrl("n");
  await expect
    .element(
      composer().getByText(
        "The configured profile cannot be used: the profile is disabled. Choose another agent.",
      ),
    )
    .toBeVisible();
  // The parser drops the refused profile from resolved settings; the fallback agent is named.
  await expect.element(composer().getByRole("button", { name: /^Agent pi/ })).toBeVisible();
  await expect
    .element(composer().getByRole("button", { name: /^Agent Gateway/ }))
    .not.toBeInTheDocument();
  await screen.unmount();
});

test("a draft whose project is removed shows it unavailable and cannot submit it", async () => {
  const { client, project, screen } = await appWithProject("composer-removed-project");
  await newTaskButton().click();
  await expect.element(projectButton()).toHaveTextContent(project.name);
  const prompt = "Keep this prompt";
  await promptField().fill(prompt);

  await client.connection.api.projects.remove({ id: project.id });
  await expect.element(projectButton()).toHaveTextContent("Project unavailable");
  // The unavailable selection keeps the project glyph; only a true No project is the scratch one.
  expect(projectButton().element().querySelector("svg")?.classList.contains("lucide-folder")).toBe(
    true,
  );
  await expect
    .element(composer().getByRole("alert"))
    .toHaveTextContent(
      "The selected project is no longer available. Choose another project or No project.",
    );
  await expect.element(promptField()).toHaveValue(prompt);
  await expect.element(createButton()).toBeDisabled();
  await expect
    .element(composer().getByRole("button", { name: /Workspace/ }))
    .not.toBeInTheDocument();
  expect(client.tasks.getSnapshot().tasks).toHaveLength(0);

  // The draft survives the reselection and is created as the scratch task it now is, not with
  // the removed project's id.
  await projectButton().click();
  await page.getByRole("option", { name: "No project" }).click();
  await expect.element(projectButton()).toHaveTextContent("No project");
  await expect.element(promptField()).toHaveValue(prompt);
  await createButton().click();
  const task = await vi.waitFor(() => {
    const found = client.tasks.getSnapshot().tasks.find((candidate) => candidate.prompt === prompt);
    if (found === undefined) throw new Error("the scratch task is not in the store yet");
    return found;
  });
  expect(task.projectId).toBeNull();
  expect(task.branch).toBeNull();
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
  await page.getByRole("option", { name: project.name }).click();
  await expect.element(composer()).toBeVisible();
  await expect.element(projectButton()).toHaveTextContent(project.name);
  await third.unmount();
});

test("Mod+Alt+N drafts without a project on an install that has one", async () => {
  const { screen } = await appWithProject("composer-direct-scratch");
  await ctrlAlt("n");
  await expect.element(composer()).toBeVisible();
  await expect.element(projectButton()).toHaveTextContent("No project");
  await expect.element(composer().getByText(/Scratch workspace/)).not.toBeInTheDocument();
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
  await selectOption("Workspace Current checkout", "New worktree");
  await expect.element(branchButton("main")).toBeVisible();
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
  await page.getByRole("option", { name: "No project" }).click();
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
  await page.getByRole("button", { name: "Close settings" }).click();
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
  const rail = page.getByRole("radiogroup", { name: "Instances" });
  await expect.element(rail.getByRole("radio", { name: "pi" })).toBeChecked();
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
    .element(page.getByRole("radiogroup", { name: "Instances" }).getByRole("radio", { name: "pi" }))
    .not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await screen.unmount();
});
