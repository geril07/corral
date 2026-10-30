import type { CorralClient } from "@corral/client/corral-client";
import type { Task } from "@corral/protocol/rpc";
import { afterEach, expect, test } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { setServerEnv } from "../../../test/fake-agents.ts";
import { clearIssueCliCalls, issueCliCalls, issueCliPath } from "../../../test/issue-cli-client.ts";
import { prefixThen, realServerClients } from "../../../test/real-client.ts";
import { renderApp } from "../../../test/render-app.tsx";
import {
  appWithProject as openProject,
  importIssueButton,
  issueUrlField,
  newTaskDialog,
  taskButton,
  taskSourceButton,
  taskSourceDialog,
} from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();
const appWithProject = () => openProject(newClient());

const GITHUB_URL = "https://github.com/acme/app/issues/7";

function issue(body: string, title = "Issue title") {
  return JSON.stringify({ number: 7, title, body });
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
  await clearIssueCliCalls();
});

test("an explicit GitHub import fills the title, keeps a local edit, and the source reopens after a reload", async () => {
  await clearIssueCliCalls();
  const { client, repo, rendered } = await appWithProject();
  await setServerEnv("FAKE_ISSUE_MODE", "ok");
  await setServerEnv("FAKE_ISSUE_RESPONSE", issue("Use <b>bold</b> & $(touch pwned)"));

  await prefixThen("t");
  await expect.element(newTaskDialog().getByRole("textbox", { name: "Title" })).toHaveFocus();
  await userEvent.fill(issueUrlField(), GITHUB_URL);
  expect(await issueCliCalls()).toEqual([]);

  await importIssueButton().click();
  await expect
    .element(newTaskDialog().getByRole("status"))
    .toMatchTextContent("Imported GitHub issue acme/app#7");
  await expect
    .element(newTaskDialog().getByRole("textbox", { name: "Title" }))
    .toHaveValue("Issue title");

  await userEvent.fill(newTaskDialog().getByRole("textbox", { name: "Title" }), "My local title");
  await newTaskDialog().getByRole("button", { name: "Create task" }).click();
  await expect.element(newTaskDialog()).not.toBeInTheDocument();
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
  expect(await issueCliCalls()).toEqual([
    {
      command: "gh",
      argv: ["issue", "view", GITHUB_URL, "--repo=github.com/acme/app", "--json=number,title,body"],
      cwd: repo,
    },
  ]);

  await rendered.unmount();
  await renderApp(client);
  await expect.element(taskButton("My local title")).toBeVisible();
  await taskSourceButton("My local title").click();
  await expect.element(taskSourceDialog().getByText("Original issue title")).toBeVisible();
  await expect.element(taskSourceDialog().getByText("Issue title", { exact: true })).toBeVisible();
  await expect.element(taskSourceDialog().getByText(/Use <b>bold<\/b>/)).toBeVisible();
  const link = taskSourceDialog().getByRole("link", { name: "Open on GitHub" });
  await expect.element(link).toHaveAttribute("href", GITHUB_URL);
  await expect.element(link).toHaveAttribute("target", "_blank");
  await expect.element(link).toHaveAttribute("rel", "noopener noreferrer");
});

test("a self-hosted host asks for GitHub or GitLab before the second explicit import", async () => {
  await clearIssueCliCalls();
  const { client, repo } = await appWithProject();
  await setServerEnv(
    "FAKE_ISSUE_RESPONSE",
    JSON.stringify({ iid: 3, title: "Self hosted title", description: "Self hosted body" }),
  );

  await prefixThen("t");
  await userEvent.fill(issueUrlField(), "https://gitlab.example.com/group/project/-/issues/3");
  await importIssueButton().click();
  await expect
    .element(newTaskDialog().getByText("gitlab.example.com could be GitHub or GitLab"))
    .toBeVisible();
  await expect.element(importIssueButton()).toBeDisabled();

  await newTaskDialog().getByRole("radio", { name: "GitLab" }).click();
  await importIssueButton().click();
  await expect
    .element(newTaskDialog().getByRole("status"))
    .toMatchTextContent("Imported GitLab issue group/project#3");
  await newTaskDialog().getByRole("button", { name: "Create task" }).click();
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
  await userEvent.fill(issueUrlField(), GITHUB_URL);

  await setServerEnv("FAKE_ISSUE_MODE", "ok");
  await setServerEnv("FAKE_ISSUE_RESPONSE", "{");
  await importIssueButton().click();
  await expect
    .element(newTaskDialog().getByRole("alert"))
    .toMatchTextContent("The issue tool returned something Corral could not read.");

  await setServerEnv("FAKE_ISSUE_MODE", "fail");
  await setServerEnv("FAKE_ISSUE_EXIT", "4");
  await setServerEnv(
    "FAKE_ISSUE_STDERR",
    "To get started with GitHub CLI, please run: gh auth login",
  );
  await importIssueButton().click();
  await expect
    .element(newTaskDialog().getByRole("alert"))
    .toMatchTextContent("The server's GitHub CLI is not logged in for this host.");

  await setServerEnv("FAKE_ISSUE_EXIT", "1");
  await setServerEnv("FAKE_ISSUE_STDERR", "dial tcp: lookup github.com: no such host");
  await importIssueButton().click();
  await expect
    .element(newTaskDialog().getByRole("alert"))
    .toMatchTextContent("dial tcp: lookup github.com: no such host");

  const previousPath = await setServerEnv("PATH", await issueCliPath("missing"));
  try {
    await importIssueButton().click();
    await expect
      .element(newTaskDialog().getByRole("alert"))
      .toMatchTextContent("gh was not found on the server's PATH.");
  } finally {
    await setServerEnv("PATH", previousPath ?? (await issueCliPath("with")));
  }
  await expect.element(newTaskDialog().getByRole("textbox", { name: "Title" })).toHaveValue("");

  await userEvent.fill(
    newTaskDialog().getByRole("textbox", { name: "Title" }),
    "Manual after failures",
  );
  await newTaskDialog().getByRole("button", { name: "Create task" }).click();
  await expect.element(taskButton("Manual after failures")).toBeVisible();
  expect(taskNamed(client, "Manual after failures").source).toBeUndefined();
  await expect.element(taskSourceButton("Manual after failures")).not.toBeInTheDocument();
});
