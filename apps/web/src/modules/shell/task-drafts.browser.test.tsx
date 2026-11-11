import type { Project } from "@corral/protocol/rpc";
import { beforeEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { createGitRepo } from "../../../test/git-repo.ts";
import { prefixThen, realServerClients } from "../../../test/real-client.ts";
import { renderApp } from "../../../test/render-app.tsx";
import { recordOf } from "./json-record.ts";
import { TASK_DRAFT_STORAGE_KEY } from "./task-drafts.ts";
import { DRAFT_STORAGE_NOTICE, DRAFT_WRITE_DELAY } from "./use-task-drafts.ts";

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

const noticeMessage = () => page.getByText("Discarded", { exact: true });
const undoButton = () => page.getByRole("button", { name: "Undo" });
const dismissNotice = () => page.getByRole("button", { name: "Dismiss status" });

async function discardDraftTab(projectName: string) {
  await userEvent.hover(draftTab(projectName));
  await page.getByRole("button", { name: `Close ${projectName} tab` }).click();
}

test("Escape keeps the draft while closing its tab discards it with an Undo", async () => {
  const { projects, screen } = await appWithProjects(["drafts-close"]);
  const project = projects[0]!;
  const prompt = "Keep me on Escape";

  await startNewTask();
  await promptField().fill(prompt);
  await userEvent.keyboard("{Escape}");
  await expect.element(composer()).not.toBeInTheDocument();
  // Escape keeps the draft and says nothing; there is no undo to dismiss.
  await expect.element(undoButton()).not.toBeInTheDocument();

  await startNewTask();
  await expect.element(promptField()).toHaveValue(prompt);

  // OpenCode's close is destructive for a draft, and T3 makes that action undoable.
  await discardDraftTab(project.name);
  await expect.element(composer()).not.toBeInTheDocument();
  await expect.element(noticeMessage()).toBeVisible();
  await undoButton().click();
  await expect.element(promptField()).toHaveValue(prompt);
  await expect.element(draftTab(project.name)).toHaveAttribute("aria-selected", "true");
  expect(draftTabs().getByRole("tab").elements()).toHaveLength(1);
  await expect.element(undoButton()).not.toBeInTheDocument();

  // The tab's own keyboard close is the same action, and the notice is dismissible without undo.
  await promptField().fill("Close with the keyboard");
  await prefixThen("q");
  await expect.element(composer()).not.toBeInTheDocument();
  await expect.element(noticeMessage()).toBeVisible();
  await dismissNotice().click();
  await expect.element(undoButton()).not.toBeInTheDocument();

  await startNewTask();
  await expect.element(promptField()).toHaveValue("");
  await screen.unmount();
});

test("discarding two drafts keeps one undo, for the last discard", async () => {
  const { projects, screen } = await appWithProjects(["drafts-undo-a", "drafts-undo-b"]);
  const alpha = projects[0]!;
  const beta = projects[1]!;

  await startNewTaskIn(alpha);
  await promptField().fill("Alpha draft");
  await userEvent.keyboard("{Escape}");
  await startNewTaskIn(beta);
  await promptField().fill("Beta draft");

  // Closing a background draft's tab keeps the open one where it is.
  await discardDraftTab(alpha.name);
  await expect.element(promptField()).toHaveValue("Beta draft");
  await expect.element(undoButton()).toBeVisible();
  expect(undoButton().elements()).toHaveLength(1);

  // The second discard replaces the first undo instead of stacking one behind it.
  await discardDraftTab(beta.name);
  expect(undoButton().elements()).toHaveLength(1);
  await undoButton().click();

  // Only beta's draft comes back; alpha's undo was replaced and is gone.
  await expect.element(draftTab(beta.name)).toHaveAttribute("aria-selected", "true");
  await expect.element(promptField()).toHaveValue("Beta draft");
  expect(draftTabs().getByRole("tab").elements()).toHaveLength(1);
  await screen.unmount();
});

test("the discard notice's Undo is a keyboard-reachable button", async () => {
  const { projects, screen } = await appWithProjects(["drafts-undo-keyboard"]);
  const project = projects[0]!;
  const prompt = "Undo with the keyboard";

  await startNewTask();
  await promptField().fill(prompt);
  await discardDraftTab(project.name);
  await expect.element(composer()).not.toBeInTheDocument();

  const undo = undoButton().element();
  expect(undo.tabIndex).toBe(0);
  undo.focus();
  await expect.element(undoButton()).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(promptField()).toHaveValue(prompt);
  await screen.unmount();
});

test("switching to a project whose draft has text opens that draft and keeps both", async () => {
  const { projects, screen } = await appWithProjects(["drafts-switch-a", "drafts-switch-b"]);
  const alpha = projects[0]!;
  const beta = projects[1]!;

  await startNewTaskIn(alpha);
  await promptField().fill("Alpha draft");
  await userEvent.keyboard("{Escape}");
  await startNewTaskIn(beta);
  await promptField().fill("Beta draft");

  // Alpha's draft has text, so beta's cannot take the project: the composer opens alpha's draft
  // and beta's keeps its own project, tab and text.
  await projectButton().click();
  await chooseProject(alpha);

  expect(draftTabs().getByRole("tab").elements()).toHaveLength(2);
  await expect.element(draftTab(alpha.name)).toHaveAttribute("aria-selected", "true");
  await expect.element(promptField()).toHaveValue("Alpha draft");
  await expect.element(projectButton()).toHaveTextContent(alpha.name);

  await draftTab(beta.name).click();
  await expect.element(promptField()).toHaveValue("Beta draft");
  await expect.element(projectButton()).toHaveTextContent(beta.name);

  // New task for alpha returns that one draft instead of opening a second.
  await userEvent.keyboard("{Escape}");
  await startNewTaskIn(alpha);
  expect(draftTabs().getByRole("tab").elements()).toHaveLength(2);
  await expect.element(promptField()).toHaveValue("Alpha draft");
  await screen.unmount();
});

test("switching to a project whose draft is empty moves the draft there", async () => {
  const { projects, screen } = await appWithProjects([
    "drafts-merge-a",
    "drafts-merge-b",
    "drafts-merge-c",
  ]);
  const beta = projects[1]!;
  const gamma = projects[2]!;

  // Gamma has a draft with nothing typed, so it has nothing to lose.
  await startNewTaskIn(gamma);
  await userEvent.keyboard("{Escape}");
  await startNewTaskIn(beta);
  await promptField().fill("Beta draft");

  await projectButton().click();
  await chooseProject(gamma);

  expect(draftTabs().getByRole("tab").elements()).toHaveLength(1);
  await expect.element(draftTab(gamma.name)).toHaveAttribute("aria-selected", "true");
  await expect.element(promptField()).toHaveValue("Beta draft");
  await expect.element(projectButton()).toHaveTextContent(gamma.name);
  await expect.element(draftTab(beta.name)).not.toBeInTheDocument();
  await screen.unmount();
});

test("two draft tabs show their project names and have distinct close controls", async () => {
  const { projects, screen } = await appWithProjects(["drafts-labels-a", "drafts-labels-b"]);
  const alpha = projects[0]!;
  const beta = projects[1]!;

  await startNewTaskIn(alpha);
  await promptField().fill("Alpha draft");
  await userEvent.keyboard("{Escape}");
  await startNewTaskIn(beta);
  await promptField().fill("Beta draft");

  const labels = draftTabs()
    .getByRole("tab")
    .elements()
    .map((element) => element.querySelector(".visual-tab-label")?.textContent);
  expect(labels).toEqual([alpha.name, beta.name]);
  await expect
    .element(page.getByRole("button", { name: `Close ${alpha.name} tab` }))
    .toBeInTheDocument();
  await expect
    .element(page.getByRole("button", { name: `Close ${beta.name} tab` }))
    .toBeInTheDocument();
  await screen.unmount();
});

test("the numbered chords select a draft", async () => {
  const { projects, screen } = await appWithProjects(["drafts-number-a", "drafts-number-b"]);
  const alpha = projects[0]!;
  const beta = projects[1]!;

  await startNewTaskIn(alpha);
  await promptField().fill("Alpha draft");
  await userEvent.keyboard("{Escape}");
  await startNewTaskIn(beta);
  await promptField().fill("Beta draft");

  const numbers = draftTabs()
    .getByRole("tab")
    .elements()
    .map((element) => element.querySelector(".visual-tab-number")?.textContent);
  expect(numbers).toEqual(["1", "2"]);

  await prefixThen("1");
  await expect.element(draftTab(alpha.name)).toHaveAttribute("aria-selected", "true");
  await expect.element(promptField()).toHaveValue("Alpha draft");
  await prefixThen("2");
  await expect.element(draftTab(beta.name)).toHaveAttribute("aria-selected", "true");
  await expect.element(promptField()).toHaveValue("Beta draft");
  await screen.unmount();
});

test("closing the last draft returns focus to the selected task tab", async () => {
  const { projects, screen } = await appWithProjects(["drafts-focus"]);
  const project = projects[0]!;

  await startNewTask();
  await promptField().fill("A task with a session");
  await createButton().click();
  const sessions = page.getByRole("tablist", { name: "Sessions" });
  await expect.element(sessions).toBeVisible();
  const selectedTab = sessions.getByRole("tab", { selected: true });
  await expect.element(selectedTab).toBeVisible();

  await startNewTask();
  await expect.element(promptField()).toHaveFocus();
  await discardDraftTab(project.name);
  await expect.element(composer()).not.toBeInTheDocument();

  await expect.element(selectedTab).toHaveFocus();
  await screen.unmount();
});

test("typing is written after the debounce, not on the keystroke", async () => {
  const { screen } = await appWithProjects(["drafts-debounce"]);
  const original = window.localStorage.setItem.bind(window.localStorage);
  const writes: number[] = [];
  const setItem = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation((key: string, value: string) => {
      if (key === TASK_DRAFT_STORAGE_KEY) writes.push(performance.now());
      original(key, value);
    });
  try {
    await startNewTask();
    // Opening a draft schedules its own write; the fill below replaces that timer.
    const started = performance.now();
    await promptField().fill("Wait for the debounce");
    const written = await vi.waitFor(() => {
      const at = writes.find((time) => time >= started);
      if (at === undefined) throw new Error("the draft is not written yet");
      return at;
    });
    // The record waits for the delay instead of being written per keystroke, and it is written
    // before the unmount the other tests end with.
    expect(written - started).toBeGreaterThanOrEqual(DRAFT_WRITE_DELAY);
    expect(writes.filter((time) => time >= started)).toHaveLength(1);
  } finally {
    setItem.mockRestore();
  }
  await screen.unmount();
});

test("closing a window that never edited writes nothing", async () => {
  const { screen } = await appWithProjects(["drafts-idle"]);
  const setItem = vi.spyOn(Storage.prototype, "setItem");
  await screen.unmount();
  const writes = setItem.mock.calls.filter(([key]) => key === TASK_DRAFT_STORAGE_KEY);
  setItem.mockRestore();
  // An idle window's empty snapshot must not replace the record another window typed into.
  expect(writes).toHaveLength(0);
});

test("a refused write says so and keeps the draft in the page", async () => {
  const { screen } = await appWithProjects(["drafts-quota"]);
  const original = window.localStorage.setItem.bind(window.localStorage);
  const setItem = vi
    .spyOn(Storage.prototype, "setItem")
    .mockImplementation((key: string, value: string) => {
      if (key === TASK_DRAFT_STORAGE_KEY)
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      original(key, value);
    });
  try {
    await startNewTask();
    await promptField().fill("Too big for this device");
    await expect.element(page.getByText(DRAFT_STORAGE_NOTICE, { exact: true })).toBeVisible();
    await expect.element(promptField()).toHaveValue("Too big for this device");
  } finally {
    setItem.mockRestore();
  }
  await screen.unmount();
  expect(storedDrafts()).toHaveLength(0);
});

test("a create of the discarded draft's project drops its Undo", async () => {
  const { client, projects, screen } = await appWithProjects(["drafts-undo-create"]);
  const project = projects[0]!;
  const prompt = "Send this only once";

  await startNewTask();
  await promptField().fill(prompt);
  await discardDraftTab(project.name);
  await expect.element(noticeMessage()).toBeVisible();

  // The same text is typed again and sent; its Undo must not bring the sent draft back.
  await startNewTask();
  await promptField().fill(prompt);
  await createButton().click();
  await vi.waitFor(() => {
    const found = client.tasks.getSnapshot().tasks.find((candidate) => candidate.prompt === prompt);
    if (found === undefined) throw new Error("the task is not in the store yet");
    return found;
  });

  await expect.element(undoButton()).not.toBeInTheDocument();
  await expect.element(noticeMessage()).not.toBeInTheDocument();
  await screen.unmount();
});
