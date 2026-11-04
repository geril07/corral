import {
  defaultClientConfig,
  type ClientConfig,
  type LaunchProfile,
  type ResolvedTaskSettings,
} from "@corral/protocol/config";
import type { AgentKind, CreateTaskInput, Project, TaskSource } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { useState } from "react";
import { render } from "vitest-browser-react";
import { emptyDraft, type ComposerDraft } from "./new-task-draft.ts";
import { NewTaskView, type NewTaskViewProps } from "./new-task-view.tsx";

const repo: Project = {
  id: "p1",
  name: "repo",
  path: "/repos/repo",
  defaultBaseBranch: "main",
};

const other: Project = {
  id: "p2",
  name: "other",
  path: "/repos/other",
  defaultBaseBranch: "trunk",
};

const issue: TaskSource = {
  provider: "github",
  host: "github.com",
  repository: "acme/app",
  number: 7,
  url: "https://github.com/acme/app/issues/7",
  title: "Issue title",
  body: "Issue body",
  fetchedAt: 1_700_000_000_000,
};

const gateway: LaunchProfile = {
  id: "gateway",
  revision: "1",
  name: "Gateway",
  agent: "claude",
  model: "claude-sonnet-4-5",
  provider: null,
  env: [],
};

const form = () => page.getByRole("form", { name: "New task" });
const prompt = () => form().getByRole("textbox", { name: "Prompt" });
const title = () => form().getByRole("textbox", { name: "Title (optional)" });
const createButton = () => form().getByRole("button", { name: /^(?:Create task|Creating…)$/ });
const picker = (name: RegExp) =>
  name.source.startsWith("^Agent ")
    ? form().getByRole("button", { name })
    : form().getByRole("combobox", { name });
const view = (name: "chat" | "terminal") => form().getByRole("button", { name: `Open in ${name}` });
async function openIssue() {
  await form().getByRole("button", { name: "Task setup actions" }).click();
  await page.getByRole("menuitem", { name: "From issue…" }).click();
}

function configWith(
  tasks: Partial<ResolvedTaskSettings> = {},
  projects: Record<string, Partial<ResolvedTaskSettings>> = {},
): ClientConfig {
  const config = defaultClientConfig("/data");
  return {
    ...config,
    tasks: { ...config.tasks, ...tasks },
    projects: Object.fromEntries(
      Object.entries(projects).map(([path, values]) => [path, { ...config.tasks, ...values }]),
    ),
  };
}

function renderView({
  projects = [repo],
  project = repo,
  config = configWith(),
  profiles = [] as LaunchProfile[],
  chatDrivers = ["pi"] as AgentKind[],
  capabilitiesReady = true,
  branches = Promise.resolve(["main", "feature/x"]),
  opened = 0,
  onCreate = vi.fn<(input: CreateTaskInput) => Promise<void>>(() => Promise.resolve()),
  onResolveIssue = vi.fn<
    (
      projectId: string,
      input: { url: string; provider?: "github" | "gitlab" | undefined },
      signal: AbortSignal,
    ) => Promise<TaskSource>
  >(async () => issue),
  onCancel = vi.fn<() => void>(),
} = {}) {
  const loadBranches = vi.fn<(projectId: string) => Promise<string[]>>(() => branches);
  const rendered = render(
    <DraftHost
      projects={projects}
      project={project}
      config={config}
      profiles={profiles}
      chatDrivers={chatDrivers}
      capabilitiesReady={capabilitiesReady}
      loadBranches={loadBranches}
      onCreate={onCreate}
      onResolveIssue={onResolveIssue}
      opened={opened}
      onCancel={onCancel}
    />,
  );
  return { rendered, onCreate, onResolveIssue, onCancel, loadBranches };
}

/** The workspace's half of the composer: it owns the draft that a remount must not lose. */
function DraftHost({
  initialDraft,
  ...props
}: Omit<NewTaskViewProps, "draft" | "onDraftChange"> & { initialDraft?: ComposerDraft }) {
  const [draft, setDraft] = useState(() => initialDraft ?? emptyDraft(props.project.id));
  return <NewTaskView {...props} draft={draft} onDraftChange={setDraft} />;
}

async function pick(name: RegExp, option: RegExp) {
  await userEvent.click(picker(name));
  if (name.source.startsWith("^Agent ")) {
    const agentName = new RegExp(option.source.split(" · ")[0]!);
    await page
      .getByRole("dialog", { name: "Agent and model" })
      .getByRole("radio", { name: agentName })
      .click();
    await userEvent.keyboard("{Escape}");
  } else await page.getByRole("option", { name: option }).click();
}

test("the prompt takes the keyboard and Enter creates the task from it", async () => {
  const { rendered, onCreate } = renderView();
  await rendered;

  await expect.element(prompt()).toHaveFocus();
  await expect.element(prompt()).toHaveAttribute("placeholder", "What should the agent do?");

  // Shift+Enter is a newline in the prompt; the bare Enter after it submits.
  await userEvent.keyboard("Fix the login bug{Shift>}{Enter}{/Shift}then the tests");
  await expect.element(prompt()).toHaveValue("Fix the login bug\nthen the tests");
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      prompt: "Fix the login bug\nthen the tests",
      agent: { kind: "claude", view: "terminal" },
      workspace: { type: "main-worktree" },
    }),
  );
});

test("nothing is created without a prompt, a title or a source", async () => {
  const { rendered, onCreate } = renderView();
  await rendered;

  await expect.element(createButton()).toBeDisabled();
  await userEvent.keyboard("{Enter}");
  expect(onCreate).not.toHaveBeenCalled();
});

test("a title alone creates an empty task: no prompt, so no agent", async () => {
  const { rendered, onCreate } = renderView();
  await rendered;

  await form().getByRole("button", { name: "Title (optional)", exact: true }).click();
  await expect.element(title()).toHaveFocus();
  await userEvent.keyboard("Only a title{Enter}");

  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      title: "Only a title",
      workspace: { type: "main-worktree" },
    }),
  );
});

test("the pickers show the project's effective settings and a project switch re-applies untouched ones", async () => {
  const config = configWith(
    { agent: { value: "codex", source: "global" } },
    {
      [repo.path]: {
        agent: { value: "codex", source: "project" },
        workspace: { value: "new-worktree", source: "project" },
      },
    },
  );
  const { rendered } = renderView({ projects: [repo, other], config });
  await rendered;

  await expect.element(picker(/^Agent /)).toHaveAccessibleName("Agent codex · Agent default");
  await expect.element(picker(/^Workspace /)).toHaveAccessibleName("Workspace new worktree");
  await expect.element(page.getByText("defaults from project settings")).toBeVisible();

  // The agent is the user's own choice now; the workspace still follows the settings.
  await pick(/^Agent /, /^opencode · Agent default$/);
  await expect.element(picker(/^Agent /)).toHaveAccessibleName("Agent opencode · Agent default");

  await pick(/^Project /, /^other/);
  await expect.element(picker(/^Project /)).toHaveAccessibleName("Project other");
  await expect.element(picker(/^Agent /)).toHaveAccessibleName("Agent opencode · Agent default");
  await expect.element(picker(/^Workspace /)).toHaveAccessibleName("Workspace main tree");
  await expect.element(page.getByText("defaults from project settings")).not.toBeInTheDocument();
});

test("a configured profile wins over the agent and carries its revision", async () => {
  const config = configWith({
    profile: { value: "gateway", source: "global" },
    agent: { value: "codex", source: "global" },
  });
  const { rendered, onCreate } = renderView({ config, profiles: [gateway] });
  await rendered;

  await expect.element(picker(/^Agent /)).toHaveAccessibleName("Agent Gateway · claude-sonnet-4-5");
  await userEvent.keyboard("Ship it{Enter}");

  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      prompt: "Ship it",
      agent: {
        kind: "claude",
        profileId: "gateway",
        expectedProfileRevision: "1",
        view: "terminal",
      },
      workspace: { type: "main-worktree" },
    }),
  );
});

test("an existing branch is picked from the workspace list with the keyboard", async () => {
  const { rendered, onCreate, loadBranches } = renderView();
  await rendered;
  expect(loadBranches).toHaveBeenLastCalledWith("p1");

  await userEvent.keyboard("Continue there");
  for (
    let step = 0;
    step < 12 && document.activeElement !== picker(/^Workspace /).element();
    step += 1
  ) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- advance one real focus step at a time
    await userEvent.keyboard("{Tab}");
  }
  await expect.element(picker(/^Workspace /)).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  // The popup's search field takes the keyboard and highlights the first match as it filters.
  await expect.element(page.getByRole("combobox", { name: "Search workspaces" })).toHaveFocus();
  await userEvent.keyboard("feat");
  await expect.element(page.getByRole("option", { name: "feature/x" })).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await expect.element(picker(/^Workspace /)).toHaveAccessibleName("Workspace feature/x");

  await prompt().click();
  await userEvent.keyboard("{Enter}");

  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      prompt: "Continue there",
      agent: { kind: "claude", view: "terminal" },
      workspace: { type: "existing-branch", branch: "feature/x" },
    }),
  );
});

test("Escape asks for the previous task back and leaves the text alone", async () => {
  const { rendered, onCancel, onCreate } = renderView();
  await rendered;

  await userEvent.keyboard("Half a thought{Escape}");
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onCreate).not.toHaveBeenCalled();
  await expect.element(prompt()).toHaveValue("Half a thought");
});

test("Escape is refused while a failed create is showing, so the draft is not thrown away", async () => {
  const onCreate = vi.fn<(input: CreateTaskInput) => Promise<void>>(() =>
    Promise.reject(new Error("fatal: invalid reference: base")),
  );
  const { rendered, onCancel } = renderView({ onCreate });
  await rendered;

  await userEvent.keyboard("Doomed{Enter}");
  await expect.element(form().getByRole("alert")).toMatchTextContent("fatal: invalid reference");

  await userEvent.keyboard("{Escape}");
  expect(onCancel).not.toHaveBeenCalled();
  await expect.element(form().getByRole("alert")).toBeVisible();
  await expect.element(prompt()).toHaveValue("Doomed");
});

test("From issue… takes the keyboard into the issue field", async () => {
  const { rendered } = renderView();
  await rendered;
  await expect.element(prompt()).toHaveFocus();

  // Keyboard only: the text button, then Enter; the field it expands takes the focus.
  form().getByRole("button", { name: "Task setup actions" }).element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("menuitem", { name: "From issue…" })).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await expect.element(form().getByRole("textbox", { name: "Issue URL" })).toHaveFocus();
});

test("changing a project does not pull the keyboard into the issue field", async () => {
  const { rendered } = renderView({ projects: [repo, other] });
  await rendered;

  // Expanding the section hands it the keyboard; a project change remounts it but must not steal it.
  await openIssue();
  await expect.element(form().getByRole("textbox", { name: "Issue URL" })).toHaveFocus();

  await userEvent.click(picker(/^Project /));
  await page.getByRole("option", { name: /^other/ }).click();
  await expect.element(picker(/^Project /)).toHaveAccessibleName("Project other");
  await expect.element(form().getByRole("textbox", { name: "Issue URL" })).not.toHaveFocus();
  await expect.element(picker(/^Project /)).toHaveFocus();
});

test("re-picking the agent already shown keeps the configured model", async () => {
  const config = configWith({
    agent: { value: "codex", source: "global" },
    model: { value: "gpt-5-codex", source: "global" },
  });
  const { rendered, onCreate } = renderView({ config });
  await rendered;

  await expect.element(picker(/^Agent /)).toHaveAccessibleName("Agent codex · gpt-5-codex");
  await pick(/^Agent /, /^codex/);
  await expect.element(picker(/^Agent /)).toHaveAccessibleName("Agent codex · gpt-5-codex");

  await prompt().click();
  await userEvent.keyboard("Model kept{Enter}");
  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      prompt: "Model kept",
      agent: { kind: "codex", model: "gpt-5-codex", view: "terminal" },
      workspace: { type: "main-worktree" },
    }),
  );
});

test("an IME Enter in the Chrome order leaves the next Enter free to submit", async () => {
  const { rendered, onCreate } = renderView();
  await rendered;
  await userEvent.keyboard("Write it");

  const field = prompt().element();
  field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  // Chrome and Firefox: the confirming keydown arrives while the composition is still active.
  field.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  expect(onCreate).not.toHaveBeenCalled();
  field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  expect(onCreate).not.toHaveBeenCalled();

  // The user's own Enter after the commit is not a composition key and submits.
  field.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  await vi.waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
});

test("a composition Enter through the real keyboard neither submits nor inserts a newline", async () => {
  const { rendered, onCreate } = renderView();
  await rendered;
  await userEvent.keyboard("Write it");

  const field = prompt().element();
  field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  // Safari ends the composition before the confirming keydown; a real key press is used so the
  // textarea's default action would insert a newline if the confirming Enter were not prevented.
  field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await userEvent.keyboard("{Enter}");
  await expect.element(prompt()).toHaveValue("Write it");
  expect(onCreate).not.toHaveBeenCalled();

  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
});

test("an IME Enter in the Safari order is not a submission", async () => {
  const { rendered, onCreate } = renderView();
  await rendered;
  await userEvent.keyboard("Write it");

  const field = prompt().element();
  field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  // Safari ends the composition before the keydown that confirms it.
  field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  field.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  expect(onCreate).not.toHaveBeenCalled();
  await expect.element(prompt()).toHaveValue("Write it");

  // The next Enter is the user's own and creates the task.
  field.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
  await vi.waitFor(() => expect(onCreate).toHaveBeenCalledOnce());
});

test("an IME Enter in the title field does not submit the form", async () => {
  const { rendered, onCreate } = renderView();
  await rendered;
  await form().getByRole("button", { name: "Title (optional)", exact: true }).click();
  await expect.element(title()).toHaveFocus();
  await userEvent.keyboard("Only a title");

  // The composition has just ended and a real Enter follows: implicit submission must not run.
  const field = title().element();
  field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await userEvent.keyboard("{Enter}");
  expect(onCreate).not.toHaveBeenCalled();

  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      title: "Only a title",
      workspace: { type: "main-worktree" },
    }),
  );
});

test("a failed create keeps the prompt and says why in the view", async () => {
  const onCreate = vi.fn<(input: CreateTaskInput) => Promise<void>>(() =>
    Promise.reject(new Error("fatal: invalid reference: base")),
  );
  const { rendered } = renderView({ onCreate });
  await rendered;

  await userEvent.keyboard("Doomed{Enter}");

  await expect.element(form().getByRole("alert")).toMatchTextContent("fatal: invalid reference");
  await expect.element(prompt()).toHaveValue("Doomed");
  await userEvent.keyboard(" retry");
  await expect.element(prompt()).toHaveValue("Doomed retry");
});

test("while the create waits the button says Creating… and the prompt stays", async () => {
  const deferred = Promise.withResolvers<void>();
  const onCreate = vi.fn<(input: CreateTaskInput) => Promise<void>>(() => deferred.promise);
  const { rendered } = renderView({ onCreate });
  await rendered;

  await userEvent.keyboard("Slow one{Enter}");
  await expect.element(form().getByRole("button", { name: "Creating…" })).toBeDisabled();
  await expect.element(prompt()).toHaveValue("Slow one");

  deferred.resolve();
  await expect.element(createButton()).toHaveTextContent("Create task");
  await expect.element(prompt()).toHaveValue("Slow one");
});

test("an imported issue fills the prompt with its title and link and keeps the snapshot", async () => {
  const { rendered, onCreate, onResolveIssue } = renderView();
  await rendered;

  await openIssue();
  const url = form().getByRole("textbox", { name: "Issue URL" });
  await userEvent.fill(url, issue.url);
  expect(onResolveIssue).not.toHaveBeenCalled();

  await form().getByRole("button", { name: "Import issue" }).click();
  await expect.element(form().getByRole("status")).toMatchTextContent("Imported GitHub issue");
  await expect.element(prompt()).toHaveValue(`Issue title\n\n${issue.url}`);
  expect(onResolveIssue.mock.calls[0]?.[0]).toBe("p1");
  expect(onResolveIssue.mock.calls[0]?.[1]).toEqual({ url: issue.url });

  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      prompt: `Issue title\n\n${issue.url}`,
      source: issue,
      agent: { kind: "claude", view: "terminal" },
      workspace: { type: "main-worktree" },
    }),
  );
});

test("a prompt the user typed is not overwritten by an import", async () => {
  const { rendered, onCreate } = renderView();
  await rendered;

  await userEvent.keyboard("My own wording");
  await openIssue();
  await userEvent.fill(form().getByRole("textbox", { name: "Issue URL" }), issue.url);
  await form().getByRole("button", { name: "Import issue" }).click();
  await expect.element(form().getByRole("status")).toBeVisible();
  await expect.element(prompt()).toHaveValue("My own wording");

  // The imported title is the task's title unless the user types one.
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      prompt: "My own wording",
      source: issue,
      agent: { kind: "claude", view: "terminal" },
      workspace: { type: "main-worktree" },
    }),
  );
});

test("switching project drops a branch and an imported prompt, and keeps a typed one", async () => {
  const { rendered } = renderView({ projects: [repo, other] });
  await rendered;

  await pick(/^Workspace /, /^feature\/x$/);
  await prompt().click();
  await userEvent.keyboard("Typed by me");
  await openIssue();
  await userEvent.fill(form().getByRole("textbox", { name: "Issue URL" }), issue.url);
  await form().getByRole("button", { name: "Import issue" }).click();
  await expect.element(form().getByRole("status")).toBeVisible();

  await pick(/^Project /, /^other/);
  await expect.element(picker(/^Workspace /)).toHaveAccessibleName("Workspace main tree");
  await expect.element(form().getByRole("status")).not.toBeInTheDocument();
  await expect.element(prompt()).toHaveValue("Typed by me");
});

test("an imported prompt is dropped when the project changes", async () => {
  const { rendered } = renderView({ projects: [repo, other] });
  await rendered;

  await openIssue();
  await userEvent.fill(form().getByRole("textbox", { name: "Issue URL" }), issue.url);
  await form().getByRole("button", { name: "Import issue" }).click();
  await expect.element(prompt()).toHaveValue(`Issue title\n\n${issue.url}`);

  await pick(/^Project /, /^other/);
  await expect.element(prompt()).toHaveValue("");
});

test("the view picker offers chat only for an agent with a chat driver", async () => {
  const config = configWith({ agent: { value: "claude", source: "global" } });
  const { rendered, onCreate } = renderView({ config, chatDrivers: ["pi"] });
  await rendered;

  await expect.element(view("terminal")).toHaveAttribute("aria-pressed", "true");
  await expect.element(view("chat")).toBeDisabled();

  // pi reports a chat driver, so the same picker offers it and the task can open there.
  await pick(/^Agent /, /^pi/);
  await view("chat").click();
  await expect.element(view("chat")).toHaveAttribute("aria-pressed", "true");

  await prompt().click();
  await userEvent.keyboard("Say hello{Enter}");
  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      prompt: "Say hello",
      agent: { kind: "pi", view: "chat" },
      workspace: { type: "main-worktree" },
    }),
  );
});

test("a configured chat view applies, and an agent without a driver falls back to the terminal", async () => {
  const config = configWith({
    agent: { value: "pi", source: "global" },
    view: { value: "chat", source: "global" },
  });
  const { rendered, onCreate } = renderView({ config, chatDrivers: ["pi"] });
  await rendered;

  await expect.element(view("chat")).toHaveAttribute("aria-pressed", "true");
  await expect.element(form()).not.toMatchTextContent("needs an agent with a chat driver");

  // The picked agent has no driver: the view control moves to the terminal and says why.
  await pick(/^Agent /, /^claude/);
  await expect.element(view("terminal")).toHaveAttribute("aria-pressed", "true");
  await expect.element(form()).toMatchTextContent("needs an agent with a chat driver");

  await prompt().click();
  await userEvent.keyboard("Terminal please{Enter}");
  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      prompt: "Terminal please",
      agent: { kind: "claude", view: "terminal" },
      workspace: { type: "main-worktree" },
    }),
  );
});

test("a disabled agent and its profiles disappear from the composer's pickers", async () => {
  const base = configWith();
  const config = {
    ...base,
    agents: {
      ...base.agents,
      claude: {
        enabled: { value: false, source: "global" as const },
        command: { value: "claude", source: "default" as const },
      },
    },
  };
  const { rendered } = renderView({ config, profiles: [gateway] });
  await rendered;

  // The default falls to the first agent still offered, and neither claude nor its profile is listed.
  await expect.element(picker(/^Agent /)).toHaveAccessibleName("Agent codex · Agent default");
  await userEvent.click(picker(/^Agent /));
  await expect.element(page.getByRole("radio", { name: /^claude/ })).not.toBeInTheDocument();
  await expect.element(page.getByRole("radio", { name: /^Gateway/ })).not.toBeInTheDocument();
  await expect.element(page.getByRole("radio", { name: /^codex/ })).toBeVisible();
});

test("a native model override preserves the prompt and an IME confirmation does not commit it", async () => {
  const { rendered, onCreate } = renderView({
    config: configWith({ agent: { value: "pi", source: "global" } }),
  });
  await rendered;
  await prompt().fill("Keep this prompt");
  await picker(/^Agent /).click();
  const popup = page.getByRole("dialog", { name: "Agent and model" });
  const model = popup.getByRole("textbox", { name: "Model override" });
  await model.fill("bad model");
  await expect.element(popup.getByRole("alert")).toMatchTextContent("native model id");
  await model.fill("openai/model-x");
  model.element().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  model.element().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await userEvent.keyboard("{Enter}");
  await expect.element(popup).toBeVisible();
  expect(onCreate).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  await expect.element(popup).not.toBeInTheDocument();
  await expect.element(prompt()).toHaveFocus();
  await expect.element(prompt()).toHaveValue("Keep this prompt");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      prompt: "Keep this prompt",
      agent: { kind: "pi", model: "openai/model-x", view: "chat" },
      workspace: { type: "main-worktree" },
    }),
  );
});

test("a chosen profile cannot silently change while a new-task draft is open", async () => {
  const { rendered, onCreate } = renderView({ profiles: [gateway] });
  const screen = await rendered;
  await prompt().fill("Pinned profile");
  await pick(/^Agent /, /^Gateway/);
  await screen.rerender(
    <DraftHost
      projects={[repo]}
      project={repo}
      config={configWith()}
      profiles={[{ ...gateway, revision: "2", model: "new-model" }]}
      chatDrivers={["pi"]}
      capabilitiesReady
      loadBranches={async () => []}
      onCreate={onCreate}
      onResolveIssue={async () => issue}
      onCancel={() => {}}
      opened={0}
    />,
  );
  await expect.element(form().getByRole("alert")).toMatchTextContent("changed in the config file");
  await expect.element(createButton()).toBeDisabled();
  await prompt().click();
  await userEvent.keyboard("{Enter}");
  expect(onCreate).not.toHaveBeenCalled();
  await pick(/^Agent /, /^Gateway/);
  await expect.element(form().getByRole("alert")).not.toBeInTheDocument();
  await prompt().click();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      prompt: "Pinned profile",
      agent: {
        kind: "claude",
        profileId: "gateway",
        expectedProfileRevision: "2",
        view: "terminal",
      },
      workspace: { type: "main-worktree" },
    }),
  );
});

test("a prompt waits for driver capabilities but a title-only task needs no agent", async () => {
  const { rendered, onCreate } = renderView({ capabilitiesReady: false });
  await rendered;
  await prompt().fill("Wait for capabilities");
  await userEvent.keyboard("{Enter}");
  expect(onCreate).not.toHaveBeenCalled();
  await expect.element(createButton()).toBeDisabled();
  await expect.element(form()).toMatchTextContent("Loading agent capabilities");
  await prompt().fill("");
  await form().getByRole("button", { name: "Title (optional)", exact: true }).click();
  await title().fill("No session yet");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(onCreate).toHaveBeenCalledExactlyOnceWith({
      projectId: "p1",
      title: "No session yet",
      workspace: { type: "main-worktree" },
    }),
  );
});
