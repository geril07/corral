import type { Project } from "@corral/protocol/rpc";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { createGitRepo } from "../../../test/git-repo.ts";
import { prefixThen, realServerClients } from "../../../test/real-client.ts";
import { renderApp } from "../../../test/render-app.tsx";
import { recordOf } from "./json-record.ts";
import { TASK_DRAFT_STORAGE_KEY } from "./task-drafts.ts";

const { newClient } = realServerClients();

const composer = () => page.getByRole("form", { name: "New task" });
const promptField = () => composer().getByRole("textbox", { name: "Prompt" });
const createButton = () => composer().getByRole("button", { name: /Create task|Creating task/ });
const projectChoice = () => page.getByRole("dialog", { name: "New task" });
const newTaskButton = () => page.getByRole("button", { name: "New task" });
const projectButton = () => composer().getByRole("button", { name: /^Project / });
const draftTabs = () => page.getByRole("tablist", { name: "New task" });
const draftTab = (projectName: string) =>
  draftTabs().getByRole("tab", { name: `New task ${projectName}` });

/** Drafts are device-local, so every test starts from an empty store on the shared page. */
beforeEach(() => window.localStorage.removeItem(TASK_DRAFT_STORAGE_KEY));

async function appWithProjects(names: readonly string[]) {
  const client = newClient();
  await expect.poll(() => client.connection.state.getSnapshot().status).toBe("connected");
  const projects = await Promise.all(
    names.map(async (name) =>
      client.connection.api.projects.add({ path: await createGitRepo(name) }),
    ),
  );
  const screen = await renderApp(client);
  await expect.poll(() => client.projects.getSnapshot().loaded).toBe(true);
  await expect.poll(() => client.tasks.getSnapshot().loaded).toBe(true);
  return { client, projects, screen };
}

async function chooseProject(project: Project) {
  await expect.element(projectChoice()).toBeVisible();
  await page.getByRole("option", { name: project.name, exact: true }).click();
  await expect.element(projectChoice()).not.toBeInTheDocument();
}

/** New task on an install with one project opens its draft without asking. */
async function startNewTask() {
  await newTaskButton().click();
  await expect.element(promptField()).toHaveFocus();
}

/** New task with more than one project asks which one, then opens that project's draft. */
async function startNewTaskIn(project: Project) {
  await newTaskButton().click();
  await chooseProject(project);
  await expect.element(promptField()).toHaveFocus();
}

function storedDrafts(): unknown[] {
  const raw = window.localStorage.getItem(TASK_DRAFT_STORAGE_KEY);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const drafts = recordOf(parsed)?.["drafts"];
  return Array.isArray(drafts) ? drafts : [];
}

test("typing survives closing the composer and a reload", async () => {
  const { projects, screen } = await appWithProjects(["drafts-reload"]);
  const project = projects[0]!;
  const prompt = "Keep the parser fix across a reload";

  await startNewTask();
  await promptField().fill(prompt);
  // A composer choice rides along with the text.
  await page.getByRole("combobox", { name: "Workspace Current checkout" }).click();
  await page.getByRole("option", { name: "New worktree" }).click();
  await expect.element(page.getByRole("combobox", { name: "Base branch main" })).toBeVisible();

  // Escape leaves the draft behind; the page then reloads from this device's storage.
  await userEvent.keyboard("{Escape}");
  await expect.element(composer()).not.toBeInTheDocument();
  await screen.unmount();

  const reloaded = newClient();
  const second = await renderApp(reloaded, ["/"]);
  await expect.poll(() => reloaded.projects.getSnapshot().loaded).toBe(true);
  await startNewTask();
  await expect.element(promptField()).toHaveValue(prompt);
  await expect.element(promptField()).toHaveFocus();
  await expect.element(projectButton()).toHaveTextContent(project.name);
  await expect.element(page.getByRole("combobox", { name: "Base branch main" })).toBeVisible();
  await second.unmount();
});

test("New task returns to the project's draft instead of opening a second one", async () => {
  const { projects, screen } = await appWithProjects(["drafts-reuse"]);
  const project = projects[0]!;
  const prompt = "Only draft for this project";

  await startNewTask();
  await promptField().fill(prompt);
  expect(draftTabs().getByRole("tab").elements()).toHaveLength(1);
  await expect.element(draftTab(project.name)).toHaveAttribute("aria-selected", "true");

  await userEvent.keyboard("{Escape}");
  await expect.element(composer()).not.toBeInTheDocument();
  await startNewTask();
  await expect.element(promptField()).toHaveValue(prompt);
  expect(draftTabs().getByRole("tab").elements()).toHaveLength(1);
  await screen.unmount();
});

test("a second project gets its own draft and keeps its own text", async () => {
  const { projects, screen } = await appWithProjects(["drafts-alpha", "drafts-beta"]);
  const alpha = projects[0]!;
  const beta = projects[1]!;

  await startNewTaskIn(alpha);
  await promptField().fill("Alpha draft");
  await userEvent.keyboard("{Escape}");
  await expect.element(composer()).not.toBeInTheDocument();

  await startNewTaskIn(beta);
  await expect.element(promptField()).toHaveValue("");
  await promptField().fill("Beta draft");
  expect(draftTabs().getByRole("tab").elements()).toHaveLength(2);

  await draftTab(alpha.name).click();
  await expect.element(promptField()).toHaveValue("Alpha draft");
  await expect.element(projectButton()).toHaveTextContent(alpha.name);
  await draftTab(beta.name).click();
  await expect.element(promptField()).toHaveValue("Beta draft");
  await expect.element(projectButton()).toHaveTextContent(beta.name);
  await screen.unmount();
});

test("a create clears only its own draft and its tab is replaced by the task", async () => {
  const { client, projects, screen } = await appWithProjects([
    "drafts-create-a",
    "drafts-create-b",
  ]);
  const alpha = projects[0]!;
  const beta = projects[1]!;

  await startNewTaskIn(alpha);
  await promptField().fill("Create from alpha");
  await userEvent.keyboard("{Escape}");
  await startNewTaskIn(beta);
  await promptField().fill("Beta draft, not sent");

  // Back to the first draft and send it.
  await draftTab(alpha.name).click();
  await expect.element(promptField()).toHaveValue("Create from alpha");
  await createButton().click();
  const task = await vi.waitFor(() => {
    const found = client.tasks
      .getSnapshot()
      .tasks.find((candidate) => candidate.prompt === "Create from alpha");
    if (found === undefined) throw new Error("the task is not in the store yet");
    return found;
  });

  // The working area is the created task's now: its primary tab, no leftover draft tab.
  await expect.element(page.getByRole("tablist", { name: "Sessions" })).toBeVisible();
  await expect
    .element(page.getByRole("tablist", { name: "Sessions" }).getByRole("tab", { selected: true }))
    .toBeVisible();
  await expect.element(draftTabs()).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: new RegExp(task.title) }))
    .toHaveAttribute("aria-current", "true");

  // The draft that sent it is gone; the other project's draft kept its text.
  await startNewTaskIn(alpha);
  await expect.element(promptField()).toHaveValue("");
  await userEvent.keyboard("{Escape}");
  await startNewTaskIn(beta);
  await expect.element(promptField()).toHaveValue("Beta draft, not sent");
  await screen.unmount();
});

test("an empty draft is not stored", async () => {
  const { screen } = await appWithProjects(["drafts-empty"]);

  await startNewTask();
  await promptField().fill("Typed, then taken back");
  await promptField().fill("");
  await userEvent.keyboard("{Escape}");
  await screen.unmount();

  expect(storedDrafts()).toHaveLength(0);
});

test("a corrupt draft record is ignored", async () => {
  window.localStorage.setItem(TASK_DRAFT_STORAGE_KEY, "{not json");
  const { screen } = await appWithProjects(["drafts-corrupt"]);

  await startNewTask();
  await expect.element(promptField()).toHaveValue("");
  await promptField().fill("Typing still works");
  await expect.element(promptField()).toHaveValue("Typing still works");
  await screen.unmount();

  // A record written by another version is not read as this version's either.
  window.localStorage.setItem(
    TASK_DRAFT_STORAGE_KEY,
    JSON.stringify({
      version: 2,
      drafts: [{ id: "future", composer: { projectId: null, prompt: "from the future" } }],
    }),
  );
  const reloaded = newClient();
  const second = await renderApp(reloaded, ["/"]);
  await expect.poll(() => reloaded.projects.getSnapshot().loaded).toBe(true);
  await startNewTask();
  await expect.element(promptField()).toHaveValue("");
  await second.unmount();
});

test("Escape keeps the draft while closing its tab discards it", async () => {
  const { projects, screen } = await appWithProjects(["drafts-close"]);
  const project = projects[0]!;
  const prompt = "Keep me on Escape";

  await startNewTask();
  await promptField().fill(prompt);
  await userEvent.keyboard("{Escape}");
  await expect.element(composer()).not.toBeInTheDocument();

  await startNewTask();
  await expect.element(promptField()).toHaveValue(prompt);

  // OpenCode's close is destructive for a draft: the tab and its text go together.
  await userEvent.hover(draftTab(project.name));
  await page.getByRole("button", { name: "Close New task tab" }).click();
  await expect.element(composer()).not.toBeInTheDocument();

  await startNewTask();
  await expect.element(promptField()).toHaveValue("");

  // The tab's own keyboard close is the same destructive action.
  await promptField().fill("Close with the keyboard");
  await prefixThen("q");
  await expect.element(composer()).not.toBeInTheDocument();
  await startNewTask();
  await expect.element(promptField()).toHaveValue("");
  await screen.unmount();
});
