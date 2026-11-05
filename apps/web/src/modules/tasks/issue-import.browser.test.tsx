import type { CorralClient } from "@corral/client/corral-client";
import type { Task } from "@corral/protocol/rpc";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { setServerEnv } from "../../../test/fake-agents.ts";
import { createGitRepo } from "../../../test/git-repo.ts";
import { clearIssueCliCalls, issueCliCalls, issueCliPath } from "../../../test/issue-cli-client.ts";
import { prefixShifted, prefixThen, realServerClients } from "../../../test/real-client.ts";
import { renderApp } from "../../../test/render-app.tsx";
import {
  addProjectDialog,
  appWithProject as openProject,
  createTaskButton,
  openIssueImport,
  expandTitleButton,
  importIssueButton,
  issueUrlField,
  newTaskView,
  openTaskSource,
  promptField,
  taskMenuTarget,
  taskButton,
  taskSourceDialog,
  titleField,
} from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();
const appWithProject = () => openProject(newClient());

const GITHUB_URL = "https://github.com/acme/app/issues/7";

function issue(body: string, title = "Issue title") {
  return JSON.stringify({
    number: 7,
    title,
    body,
    url: "https://github.com/acme/app/issues/7",
  });
}

function taskNamed(client: CorralClient, title: string): Task {
  const task = client.tasks.getSnapshot().tasks.find((candidate) => candidate.title === title);
  if (!task) throw new Error(`no task "${title}"`);
  return task;
}

afterEach(async () => {
  await setServerEnv("PATH", await issueCliPath("with"));
  await setServerEnv("FAKE_ISSUE_MODE", "ok");
  await setServerEnv("FAKE_ISSUE_RESPONSE", "");
  await setServerEnv("FAKE_ISSUE_STDERR", "");
  await setServerEnv("FAKE_ISSUE_EXIT", "1");
  await setServerEnv("GH_ENTERPRISE_TOKEN", null);
  await setServerEnv("GITLAB_HOST", null);
  await clearIssueCliCalls();
});

test("an explicit GitHub import fills the prompt, keeps a local title, and the source reopens after a reload", async () => {
  await clearIssueCliCalls();
  const { client, repo, rendered } = await appWithProject();
  await setServerEnv("FAKE_ISSUE_MODE", "ok");
  await setServerEnv("FAKE_ISSUE_RESPONSE", issue("Use <b>bold</b> & $(touch pwned)"));

  await prefixThen("t");
  await expect.element(promptField()).toHaveFocus();
  await openIssueImport();
  await userEvent.fill(issueUrlField(), GITHUB_URL);
  expect(await issueCliCalls()).toEqual([]);

  await importIssueButton().click();
  await expect
    .element(newTaskView().getByRole("status"))
    .toMatchTextContent("Imported GitHub issue acme/app#7");
  await expect.element(promptField()).toHaveValue(`Issue title\n\n${GITHUB_URL}`);

  await expandTitleButton().click();
  await userEvent.fill(titleField(), "My local title");
  await createTaskButton().click();
  await expect.element(newTaskView()).not.toBeInTheDocument();
  await expect.element(taskButton("My local title")).toBeVisible();
  const created = taskNamed(client, "My local title");
  expect(created.source).toMatchObject({
    provider: "github",
    repository: "acme/app",
    number: 7,
    url: GITHUB_URL,
    title: "Issue title",
    body: "Use <b>bold</b> & $(touch pwned)",
  });
  expect(created.prompt).toBe(`Issue title\n\n${GITHUB_URL}`);
  expect(await issueCliCalls()).toEqual([
    {
      command: "gh",
      argv: [
        "issue",
        "view",
        GITHUB_URL,
        "--repo=github.com/acme/app",
        "--json=number,title,body,url",
      ],
      cwd: repo,
    },
  ]);

  await rendered.unmount();
  await renderApp(client);
  await expect.element(taskButton("My local title")).toBeVisible();
  await openTaskSource("My local title");
  await expect.element(taskSourceDialog().getByText("Original issue title")).toBeVisible();
  await expect.element(taskSourceDialog().getByText("Issue title", { exact: true })).toBeVisible();
  await expect.element(taskSourceDialog().getByText(/Use <b>bold<\/b>/)).toBeVisible();
  const link = taskSourceDialog().getByRole("link", { name: "Open on GitHub" });
  await expect.element(link).toHaveAttribute("href", GITHUB_URL);
  await expect.element(link).toHaveAttribute("target", "_blank");
  await expect.element(link).toHaveAttribute("rel", "noopener noreferrer");

  // The source dialog owns the keyboard: the new-task key does nothing behind it.
  await userEvent.keyboard("{Alt>}a{/Alt}t");
  await expect.element(newTaskView()).not.toBeInTheDocument();
  await taskSourceDialog().getByRole("button", { name: "Close" }).click();
  await expect.element(taskMenuTarget("My local title")).toHaveFocus();
});

test("a CLI answer that names a pull request is refused as a pull request and keeps the URL", async () => {
  await appWithProject();
  await setServerEnv("FAKE_ISSUE_MODE", "ok");
  await setServerEnv(
    "FAKE_ISSUE_RESPONSE",
    JSON.stringify({
      number: 7,
      title: "A pull request",
      body: "",
      url: "https://github.com/acme/app/pull/7",
    }),
  );

  await prefixThen("t");
  await openIssueImport();
  await userEvent.fill(issueUrlField(), GITHUB_URL);
  await importIssueButton().click();
  await expect
    .element(newTaskView().getByRole("alert"))
    .toMatchTextContent(
      "That URL is a pull request, not an issue. Import an issue URL or create the task manually.",
    );
  await expect.element(issueUrlField()).toHaveValue(GITHUB_URL);

  // The same field still imports once the answer names an issue.
  await setServerEnv("FAKE_ISSUE_RESPONSE", issue("Issue body"));
  await importIssueButton().click();
  await expect
    .element(newTaskView().getByRole("status"))
    .toMatchTextContent("Imported GitHub issue acme/app#7");
  await expect.element(issueUrlField()).toHaveValue(GITHUB_URL);
  await expect.element(promptField()).toHaveValue(`Issue title\n\n${GITHUB_URL}`);
});

test("a self-hosted host asks for GitHub or GitLab before the second explicit import", async () => {
  await clearIssueCliCalls();
  const { client, repo } = await appWithProject();
  await setServerEnv("GITLAB_HOST", "gitlab.example.com");
  await setServerEnv(
    "FAKE_ISSUE_RESPONSE",
    JSON.stringify({
      iid: 3,
      title: "Self hosted title",
      description: "Self hosted body",
      web_url: "https://gitlab.example.com/group/project/-/issues/3",
    }),
  );

  await prefixThen("t");
  await openIssueImport();
  await userEvent.fill(issueUrlField(), "https://gitlab.example.com/group/project/-/issues/3");
  await importIssueButton().click();
  await expect
    .element(newTaskView().getByText("gitlab.example.com could be GitHub or GitLab"))
    .toBeVisible();
  await expect.element(importIssueButton()).toBeDisabled();

  await newTaskView().getByRole("radio", { name: "GitLab" }).click();
  await importIssueButton().click();
  await expect
    .element(newTaskView().getByRole("status"))
    .toMatchTextContent("Imported GitLab issue group/project#3");
  await createTaskButton().click();
  await expect.element(taskButton("Self hosted title")).toBeVisible();
  expect(taskNamed(client, "Self hosted title").source).toMatchObject({
    provider: "gitlab",
    host: "gitlab.example.com",
    repository: "group/project",
    number: 3,
  });

  expect(await issueCliCalls()).toEqual([
    {
      command: "glab",
      argv: [
        "issue",
        "view",
        "https://gitlab.example.com/group/project/-/issues/3",
        "--output=json",
      ],
      cwd: repo,
    },
  ]);
});

test("malformed, auth, network and missing-CLI failures leave manual creation working and no source", async () => {
  const { client } = await appWithProject();
  await prefixThen("t");
  await openIssueImport();
  await userEvent.fill(issueUrlField(), GITHUB_URL);

  await setServerEnv("FAKE_ISSUE_MODE", "ok");
  await setServerEnv("FAKE_ISSUE_RESPONSE", "{");
  await importIssueButton().click();
  await expect
    .element(newTaskView().getByRole("alert"))
    .toMatchTextContent("The issue tool returned something Corral could not read.");
  await expect.element(issueUrlField()).toHaveValue(GITHUB_URL);

  await setServerEnv("FAKE_ISSUE_MODE", "fail");
  await setServerEnv("FAKE_ISSUE_EXIT", "4");
  await setServerEnv(
    "FAKE_ISSUE_STDERR",
    "To get started with GitHub CLI, please run: gh auth login",
  );
  await importIssueButton().click();
  await expect
    .element(newTaskView().getByRole("alert"))
    .toMatchTextContent("The server's GitHub CLI is not logged in for this host.");

  await setServerEnv("FAKE_ISSUE_EXIT", "1");
  await setServerEnv("FAKE_ISSUE_STDERR", "dial tcp: lookup github.com: no such host");
  await importIssueButton().click();
  await expect
    .element(newTaskView().getByRole("alert"))
    .toMatchTextContent("Could not reach the issue host.");

  const previousPath = await setServerEnv("PATH", await issueCliPath("missing"));
  try {
    await importIssueButton().click();
    await expect
      .element(newTaskView().getByRole("alert"))
      .toMatchTextContent("gh was not found on the server's PATH.");
  } finally {
    await setServerEnv("PATH", previousPath ?? (await issueCliPath("with")));
  }
  await expect.element(promptField()).toHaveValue("");

  await expandTitleButton().click();
  await userEvent.fill(titleField(), "Manual after failures");
  await createTaskButton().click();
  await expect.element(taskButton("Manual after failures")).toBeVisible();
  expect(taskNamed(client, "Manual after failures").source).toBeUndefined();
  await taskMenuTarget("Manual after failures").click({ button: "right" });
  await expect
    .element(page.getByRole("menuitem", { name: "View issue source…" }))
    .not.toBeInTheDocument();
});

test("an arbitrary host chosen as GitHub is untrusted before the CLI runs", async () => {
  await clearIssueCliCalls();
  const { client } = await appWithProject();
  await setServerEnv("GH_ENTERPRISE_TOKEN", "SENTINEL_ENTERPRISE_TOKEN");

  await prefixThen("t");
  await openIssueImport();
  await userEvent.fill(issueUrlField(), "https://attacker.example/acme/app/issues/1");
  await importIssueButton().click();
  await expect
    .element(newTaskView().getByText("attacker.example could be GitHub or GitLab"))
    .toBeVisible();
  await newTaskView().getByRole("radio", { name: "GitHub" }).click();
  await importIssueButton().click();
  await expect
    .element(newTaskView().getByRole("alert"))
    .toMatchTextContent(/attacker\.example is not a configured GitHub host/);
  expect(await issueCliCalls()).toEqual([]);

  await expandTitleButton().click();
  await userEvent.fill(titleField(), "Manual after untrusted host");
  await createTaskButton().click();
  await expect.element(taskButton("Manual after untrusted host")).toBeVisible();
  expect(taskNamed(client, "Manual after untrusted host").source).toBeUndefined();
});

test("the project chooser uses the current project host/cwd and cancels a pending import on switch", async () => {
  await clearIssueCliCalls();
  const { client, repo } = await appWithProject();
  await setServerEnv("GITLAB_HOST", "gitlab.example.com");
  await setServerEnv(
    "FAKE_ISSUE_RESPONSE",
    JSON.stringify({
      iid: 3,
      title: "Selected project issue",
      description: "Selected project body",
      web_url: "https://gitlab.example.com/group/project/-/issues/3",
    }),
  );

  await prefixThen("t");
  await expandTitleButton().click();
  await userEvent.fill(titleField(), "Here");
  await createTaskButton().click();
  await expect.element(taskButton("Here")).toBeVisible();
  const first = client.projects.getSnapshot().projects.find((project) => project.path === repo)!;

  const otherRepo = await createGitRepo("second");
  await prefixShifted("p");
  await userEvent.fill(addProjectDialog().getByRole("textbox"), otherRepo);
  await userEvent.keyboard("{Enter}");
  await expect.element(addProjectDialog()).not.toBeInTheDocument();
  const other = client.projects.getSnapshot().projects.find((p) => p.path === otherRepo)!;

  // The task in the first project selects that project for the composer (flat mode lists tasks).
  await taskButton("Here").click();
  await prefixThen("t");
  await openIssueImport();
  await userEvent.fill(issueUrlField(), "https://gitlab.example.com/group/project/-/issues/3");
  await importIssueButton().click();
  await expect
    .element(newTaskView().getByText("gitlab.example.com could be GitHub or GitLab"))
    .toBeVisible();
  await newTaskView().getByRole("radio", { name: "GitLab" }).click();
  await setServerEnv("FAKE_ISSUE_MODE", "slow");
  await importIssueButton().click();
  await expect.element(newTaskView().getByRole("button", { name: "Importing…" })).toBeVisible();
  await vi.waitFor(async () => expect(await issueCliCalls()).toHaveLength(1));

  // A project switch while the read is pending: the old request is cancelled and its list cleared.
  const picker = newTaskView().getByRole("combobox", { name: /^Project / });
  await userEvent.click(picker);
  await page.getByRole("option", { name: new RegExp(other.name) }).click();
  await expect.element(picker).toHaveAccessibleName(`Project ${other.name}`);
  await expect.element(importIssueButton()).toBeVisible();
  await expect.element(newTaskView().getByRole("status")).not.toBeInTheDocument();

  await setServerEnv("FAKE_ISSUE_MODE", "ok");
  await userEvent.fill(issueUrlField(), "https://gitlab.example.com/group/project/-/issues/3");
  await importIssueButton().click();
  await expect
    .element(newTaskView().getByText("gitlab.example.com could be GitHub or GitLab"))
    .toBeVisible();
  await newTaskView().getByRole("radio", { name: "GitLab" }).click();
  await importIssueButton().click();
  await expect
    .element(newTaskView().getByRole("status"))
    .toMatchTextContent("Imported GitLab issue group/project#3");
  await createTaskButton().click();
  await expect.element(taskButton("Selected project issue")).toBeVisible();
  expect(taskNamed(client, "Selected project issue").projectId).toBe(other.id);
  expect(await issueCliCalls()).toEqual([
    {
      command: "glab",
      argv: [
        "issue",
        "view",
        "https://gitlab.example.com/group/project/-/issues/3",
        "--output=json",
      ],
      cwd: first.path,
    },
    {
      command: "glab",
      argv: [
        "issue",
        "view",
        "https://gitlab.example.com/group/project/-/issues/3",
        "--output=json",
      ],
      cwd: other.path,
    },
  ]);
});
