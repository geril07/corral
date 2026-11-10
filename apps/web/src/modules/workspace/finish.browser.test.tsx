import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { setServerEnv } from "../../../test/fake-agents.ts";
import { writeFilesIn } from "../../../test/files-client.ts";
import { runGitIn } from "../../../test/git-client.ts";
import { createGitRepoWithRemote } from "../../../test/git-repo.ts";
import { clearIssueCliCalls, issueCliCalls, issueCliPath } from "../../../test/issue-cli-client.ts";
import { prefixShifted, realServerClients } from "../../../test/real-client.ts";
import { renderApp } from "../../../test/render-app.tsx";
import { sessionTab, shellTabs, taskHeader, workspace } from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();
const SIZE = { cols: 80, rows: 24 };
const PR_URL = "https://forge.invalid/acme/app/pull/7";

const finish = () => page.getByRole("group", { name: "Finish" });
const commitMessage = () => finish().getByRole("textbox", { name: "Commit message" });
const headerBadge = () => taskHeader().getByRole("button", { name: /PR #7/ });

/** The bare repository's ref, or `undefined` while it has none. */
async function originRef(origin: string, branch: string): Promise<string | undefined> {
  return runGitIn(origin, ["rev-parse", "--verify", `refs/heads/${branch}`])
    .then((out) => out.trim())
    .catch(() => undefined);
}

test("stage, commit, push and create a pull request against the fakes, leaving the session alone", async () => {
  await setServerEnv("PATH", await issueCliPath("with"));
  await setServerEnv("FAKE_ISSUE_MODE", "ok");
  await setServerEnv("FAKE_PR_URL", PR_URL);
  await setServerEnv("FAKE_PR_CHECKS", JSON.stringify([{ bucket: "pass", name: "build" }]));
  await clearIssueCliCalls();

  const { repo, origin } = await createGitRepoWithRemote("finish");
  const setup = newClient();
  await expect.poll(() => setup.connection.state.getSnapshot().status).toBe("connected");
  const { api } = setup.connection;
  const project = await api.projects.add({ path: repo });
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Ship the change",
    workspace: { type: "new-branch" },
  });
  const session = await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });
  await writeFilesIn(task.workspacePath, {
    "README.md": "hello\nchanged\n",
    "src/one.ts": "export const one = 1;\n",
  });
  await setServerEnv(
    "FAKE_PR_VIEW",
    JSON.stringify({
      number: 7,
      url: PR_URL,
      title: "Ship the change",
      state: "OPEN",
      isDraft: false,
      baseRefName: "main",
      headRefName: task.branch,
      statusCheckRollup: [],
    }),
  );

  await renderApp(newClient(), [`/?project=${project.id}&task=${task.id}&entry=${session.id}`]);
  await expect.element(sessionTab("shell")).toHaveAttribute("aria-selected", "true");

  // The Changes tab, by key, with the write controls under the summary row.
  await prefixShifted("c");
  await expect
    .element(page.getByRole("tab", { name: "Changes" }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(finish()).toBeVisible();
  await expect.element(finish().getByRole("button", { name: "Stage all" })).toBeVisible();

  // Stage everything, type a message, commit: the controls move with the result and the CLI stays out.
  await finish().getByRole("button", { name: "Stage all" }).click();
  await expect.element(finish().getByText("2 staged")).toBeVisible();
  await userEvent.fill(commitMessage(), "feat: ship the change");
  await finish().getByRole("button", { name: "Commit", exact: true }).click();
  await expect.element(finish().getByText("nothing staged")).toBeVisible();
  const commit = (await runGitIn(task.workspacePath, ["rev-parse", "HEAD"])).trim();
  expect((await runGitIn(task.workspacePath, ["log", "-1", "--format=%s"])).trim()).toBe(
    "feat: ship the change",
  );
  // The commit is local: the remote has no such branch until the push is confirmed.
  expect(await originRef(origin, task.branch!)).toBeUndefined();
  expect(await issueCliCalls()).toEqual([]);

  // Push: the confirmation names the remote's URL and the branch, then the bare repo has both.
  await finish().getByRole("button", { name: "Push…" }).click();
  const pushDialog = page.getByRole("dialog", { name: `Push ${task.branch} to origin?` });
  await expect.element(pushDialog).toBeVisible();
  await expect.element(pushDialog.getByText(new RegExp(origin))).toBeVisible();
  await expect.element(pushDialog.getByText(new RegExp(`branch ${task.branch}`))).toBeVisible();
  await pushDialog.getByRole("button", { name: `Push ${task.branch}` }).click();
  await expect.poll(() => originRef(origin, task.branch!)).toBe(commit);

  // Create: the second confirmation names the request's target and says it does not push. A double
  // click must still open one request.
  await finish().getByRole("button", { name: "Create pull request…" }).click();
  const createDialog = page.getByRole("dialog", { name: "Create a pull request" });
  await expect.element(createDialog).toBeVisible();
  await expect
    .element(createDialog.getByText(new RegExp(`From ${task.branch} into main`)))
    .toBeVisible();
  await userEvent.dblClick(createDialog.getByRole("button", { name: "Create in main" }));

  // The header badge and the sidebar row carry the request; the tab shows it too.
  await expect.element(headerBadge()).toBeVisible();
  await expect.element(finish().getByRole("button", { name: /PR #7 open/ })).toBeVisible();
  await expect
    .element(workspace().getByRole("button", { name: /Ship the change — .*PR #7 open/ }))
    .toBeVisible();
  const creates = (await issueCliCalls()).filter(
    (call) => call.argv[0] === "pr" && call.argv[1] === "create",
  );
  expect(creates).toHaveLength(1);
  expect(creates[0]?.argv).toEqual([
    "pr",
    "create",
    "--base",
    "main",
    "--head",
    task.branch,
    "--title",
    "Ship the change",
    "--body-file",
    "-",
  ]);

  // No session changed: the strip still holds the one shell and the Changes tab, the shell is still
  // the session behind the tab, and the route still names it.
  expect(shellTabs().elements()).toHaveLength(1);
  await expect.element(sessionTab("shell")).toHaveAttribute("aria-current", "true");
  await expect.element(sessionTab("shell")).not.toHaveAttribute("aria-selected", "true");

  // The state is refreshed on focus, and a merged request offers settle without settling.
  await setServerEnv(
    "FAKE_PR_VIEW",
    JSON.stringify({
      number: 7,
      url: PR_URL,
      title: "Ship the change",
      state: "MERGED",
      isDraft: false,
      baseRefName: "main",
      headRefName: task.branch,
      statusCheckRollup: [],
    }),
  );
  window.dispatchEvent(new Event("focus"));
  await expect.element(finish().getByRole("button", { name: "Settle task" })).toBeVisible();
  await expect.element(headerBadge()).toHaveAccessibleName(/PR #7 merged/);
  expect(await api.changes.pullRequest({ id: task.id })).toMatchObject({ state: "merged" });
  expect(
    await vi.waitFor(
      () => setup.tasks.getSnapshot().tasks.find((each) => each.id === task.id)?.state,
    ),
  ).toBe("active");

  // A read the CLI cannot answer is unknown in the badge, never closed.
  await setServerEnv("FAKE_ISSUE_MODE", "fail");
  await setServerEnv("FAKE_ISSUE_EXIT", "4");
  await setServerEnv(
    "FAKE_ISSUE_STDERR",
    "To get started with GitHub CLI, please run: gh auth login",
  );
  window.dispatchEvent(new Event("focus"));
  await expect.element(headerBadge()).toHaveAccessibleName(/state unknown/);
  await expect.element(headerBadge()).toHaveAccessibleName(/not logged in/);
  await setServerEnv("FAKE_ISSUE_MODE", "ok");
});
