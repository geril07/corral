import type { ChangesRemote, Project, Task } from "@corral/protocol/rpc";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { cloneOfOrigin, runGit, writeFiles } from "../../test/git-repo.ts";
import { useFakeIssueClis } from "../../test/issue-clis.ts";
import { useServer, within } from "../../test/server-fixture.ts";

const server = useServer();
const clis = useFakeIssueClis();

type Api = Awaited<ReturnType<typeof server.rpc>>;
type Created = { origin: string; clone: string; project: Project };

/** A clone whose `origin` is a local bare repository, added as a project, and the API to drive it. */
async function projectWithBareRemote(api: Api): Promise<Created> {
  const { origin, clone } = cloneOfOrigin(join(server.scratchDir, "remote"));
  const project = await api.projects.add({ path: clone });
  return { origin, clone, project };
}

/**
 * A task in a new worktree with two uncommitted edits. Its branch has no upstream (worktrees are
 * created `--no-track`), so the push has to resolve `origin` itself, which is the case decision c
 * settles.
 */
async function worktreeTask(
  api: Api,
  created: Created,
): Promise<{ task: Task; branch: string; remote: ChangesRemote }> {
  const task = await api.tasks.create({
    projectId: created.project.id,
    title: "Ship the change",
    workspace: { type: "new-branch" },
  });
  writeFiles(task.workspacePath, { "src/one.ts": "export const one = 1;\n", "notes.txt": "two\n" });
  const remote = await api.changes.finish({ id: task.id });
  return {
    task,
    branch: task.branch,
    remote: { name: remote.remote!.name, url: remote.remote!.url },
  };
}

/** The bare repository's commit for `branch`, or `undefined` when it has none. */
function originCommit(origin: string, branch: string): string | undefined {
  try {
    return runGit(origin, "rev-parse", "--verify", `refs/heads/${branch}`).trim();
  } catch {
    return undefined;
  }
}

test("staging, committing and pushing reach the local bare remote, and no forge CLI runs", async () => {
  const api = await server.rpc();
  const created = await projectWithBareRemote(api);
  const { task, branch, remote } = await worktreeTask(api, created);

  const start = await api.changes.finish({ id: task.id });
  expect(start.branch).toBe(branch);
  expect(start.base).toBe("trunk");
  // The bare repository is the remote, named and with the URL the confirmation would show.
  expect(start.remote).toEqual({ name: "origin", url: created.origin });
  expect(start.staged).toEqual([]);

  // One selected path, then everything, then one path taken out again.
  expect(
    (await api.changes.stage({ id: task.id, paths: ["src/one.ts"], staged: true })).staged,
  ).toEqual(["src/one.ts"]);
  expect((await api.changes.stage({ id: task.id, paths: "all", staged: true })).staged).toEqual([
    "notes.txt",
    "src/one.ts",
  ]);
  expect(
    (await api.changes.stage({ id: task.id, paths: ["src/one.ts"], staged: false })).staged,
  ).toEqual(["notes.txt"]);

  const committed = await api.changes.commit({ id: task.id, message: "feat: ship one and two" });
  expect(committed.subject).toBe("feat: ship one and two");
  expect(committed.sha).toBe(runGit(task.workspacePath, "rev-parse", "HEAD").trim());
  expect(committed.finish.staged).toEqual([]);
  expect(runGit(task.workspacePath, "log", "-1", "--format=%s").trim()).toBe(
    "feat: ship one and two",
  );
  // Nothing was pushed by the commit: the remote has no such branch yet.
  expect(originCommit(created.origin, branch)).toBeUndefined();

  const pushed = await api.changes.push({ id: task.id, remote, branch });
  expect(pushed.commit).toBe(committed.sha);
  expect(pushed.finish.remote).toEqual(remote);
  // The bare repository received the branch, at the commit that was made.
  expect(originCommit(created.origin, branch)).toBe(committed.sha);
  expect(runGit(created.origin, "log", "-1", "--format=%s", branch).trim()).toBe(
    "feat: ship one and two",
  );
  // Pushing is git and only git: no forge CLI is involved until a request is created.
  expect(clis.calls()).toEqual([]);
});

test("a push refuses a remote URL or a branch that is not the one confirmed", async () => {
  const api = await server.rpc();
  const created = await projectWithBareRemote(api);
  const { task, branch, remote } = await worktreeTask(api, created);

  await expect(
    api.changes.push({
      id: task.id,
      remote: { name: remote.name, url: `${remote.url}-somewhere-else` },
      branch,
    }),
  ).rejects.toMatchObject({
    code: "CHANGES_REMOTE_MISMATCH",
    data: { remote: "origin", confirmed: `${remote.url}-somewhere-else`, actual: remote.url },
  });
  // The refusal came before git: the branch never left the machine.
  expect(originCommit(created.origin, branch)).toBeUndefined();

  await expect(
    api.changes.push({ id: task.id, remote, branch: "another-branch" }),
  ).rejects.toMatchObject({
    code: "CHANGES_BRANCH_MISMATCH",
    data: { confirmed: "another-branch", actual: branch },
  });
  expect(originCommit(created.origin, branch)).toBeUndefined();
});

test("a commit keeps the user's message and refuses an empty one or an empty index", async () => {
  const api = await server.rpc();
  const created = await projectWithBareRemote(api);
  const { task } = await worktreeTask(api, created);

  await expect(api.changes.commit({ id: task.id, message: "   \n" })).rejects.toMatchObject({
    code: "CHANGES_EMPTY_MESSAGE",
  });
  await expect(api.changes.commit({ id: task.id, message: "feat: nothing" })).rejects.toMatchObject(
    {
      code: "CHANGES_NOTHING_STAGED",
    },
  );
  // Neither refusal created a commit.
  expect(runGit(task.workspacePath, "log", "-1", "--format=%s").trim()).toBe("initial commit");

  await api.changes.stage({ id: task.id, paths: "all", staged: true });
  const committed = await api.changes.commit({
    id: task.id,
    message: "fix: left as typed\n\nbody",
  });
  expect(runGit(task.workspacePath, "log", "-1", "--format=%B").trim()).toBe(
    "fix: left as typed\n\nbody",
  );
  expect(committed.finish.staged).toEqual([]);
});

/** The `gh pr view` answer for the branch a test pushed, with the state it wants to report. */
function ghView(branch: string, state: string, draft = false): unknown {
  return {
    number: 7,
    url: "https://forge.invalid/acme/app/pull/7",
    title: "Ship the change",
    state,
    isDraft: draft,
    baseRefName: "trunk",
    headRefName: branch,
    statusCheckRollup: [],
  };
}

test("a pull request is created through gh after the push, stored on the task and refreshed", async () => {
  const api = await server.rpc();
  const created = await projectWithBareRemote(api);
  const { task, branch, remote } = await worktreeTask(api, created);
  await api.changes.stage({ id: task.id, paths: "all", staged: true });
  await api.changes.commit({ id: task.id, message: "feat: ship it" });
  await api.changes.push({ id: task.id, remote, branch });

  clis.view(ghView(branch, "OPEN"));
  clis.checks([
    { bucket: "pass", name: "build" },
    { bucket: "pending", name: "deploy" },
  ]);
  const request = await api.changes.createPullRequest({
    id: task.id,
    provider: "github",
    remote,
    branch,
    base: "trunk",
    title: "Ship the change",
    body: "The body the user typed.\n",
  });

  expect(request).toMatchObject({
    taskId: task.id,
    provider: "github",
    host: "forge.invalid",
    number: 7,
    url: "https://forge.invalid/acme/app/pull/7",
    branch,
    base: "trunk",
    state: "open",
    stateReason: null,
    checks: { total: 2, passing: 1, pending: 1, failing: 0, skipped: 0 },
  });
  expect(request.fetchedAt).toEqual(expect.any(Number));

  // The argv the brief specifies, with the body on stdin: no token, no host in an argument.
  const [create, view, checks] = clis.calls();
  expect(create).toMatchObject({
    command: "gh",
    argv: [
      "pr",
      "create",
      "--base",
      "trunk",
      "--head",
      branch,
      "--title",
      "Ship the change",
      "--body-file",
      "-",
    ],
    cwd: task.workspacePath,
    stdin: "The body the user typed.\n",
  });
  expect(view?.argv.slice(0, 3)).toEqual(["pr", "view", "--json"]);
  expect(checks?.argv).toEqual(["pr", "checks", "--json", "bucket,name,state"]);
  // No real forge name reached the CLI at any point.
  expect(clis.calls()).toHaveLength(3);
  for (const call of clis.calls()) {
    const text = [call.command, ...call.argv, call.cwd, call.stdin ?? ""].join(" ");
    expect(text).not.toMatch(/github\.com|gitlab\.com|ghe\.com/);
  }

  // Stored on the task and read back without touching the CLI again.
  expect(await api.changes.pullRequest({ id: task.id })).toEqual(request);
  expect(clis.calls()).toHaveLength(3);
});

test("creating a pull request refuses a branch the remote does not have, and runs no CLI", async () => {
  const api = await server.rpc();
  const created = await projectWithBareRemote(api);
  const { task, branch, remote } = await worktreeTask(api, created);
  await api.changes.stage({ id: task.id, paths: "all", staged: true });
  await api.changes.commit({ id: task.id, message: "feat: ship it" });

  await expect(
    api.changes.createPullRequest({
      id: task.id,
      provider: "github",
      remote,
      branch,
      base: "trunk",
      title: "Ship the change",
      body: "",
    }),
  ).rejects.toMatchObject({
    code: "CHANGES_PUSH_REQUIRED",
    data: { remote: "origin", branch },
  });
  // `gh pr create` would have pushed the branch; refusing instead is what keeps the write explicit.
  expect(clis.calls()).toEqual([]);
  expect(await api.changes.pullRequest({ id: task.id })).toBeNull();
});

test("a logged-out CLI is a typed refusal, and a refresh it cannot read is unknown, never closed", async () => {
  const api = await server.rpc();
  const created = await projectWithBareRemote(api);
  const { task, branch, remote } = await worktreeTask(api, created);
  await api.changes.stage({ id: task.id, paths: "all", staged: true });
  await api.changes.commit({ id: task.id, message: "feat: ship it" });
  await api.changes.push({ id: task.id, remote, branch });

  clis.fail(4, "To get started with GitHub CLI, please run:  gh auth login");
  await expect(
    api.changes.createPullRequest({
      id: task.id,
      provider: "github",
      remote,
      branch,
      base: "trunk",
      title: "Ship the change",
      body: "",
    }),
  ).rejects.toMatchObject({ code: "CHANGES_AUTH_REQUIRED", data: { provider: "github" } });

  // A request that exists, then a read that cannot confirm its state.
  clis.answer({});
  clis.view(ghView(branch, "OPEN"));
  const request = await api.changes.createPullRequest({
    id: task.id,
    provider: "github",
    remote,
    branch,
    base: "trunk",
    title: "Ship the change",
    body: "",
  });
  expect(request.state).toBe("open");

  clis.fail(1, "dial tcp: lookup forge.invalid: no such host");
  const unreadable = await api.changes.pullRequest({ id: task.id, refresh: true });
  expect(unreadable).toMatchObject({
    url: request.url,
    number: 7,
    state: "unknown",
    checks: null,
  });
  expect(unreadable?.stateReason).toContain("Could not reach GitHub");
  // The stored row says unknown too: the link stays, and nothing turned it into a closed request.
  expect(await api.changes.pullRequest({ id: task.id })).toMatchObject({ state: "unknown" });
});

test("a merged request is reported as merged, survives a restart with its link, and offers settle", async () => {
  const api = await server.rpc();
  const created = await projectWithBareRemote(api);
  const { task, branch, remote } = await worktreeTask(api, created);
  await api.changes.stage({ id: task.id, paths: "all", staged: true });
  await api.changes.commit({ id: task.id, message: "feat: ship it" });
  await api.changes.push({ id: task.id, remote, branch });

  clis.view(ghView(branch, "OPEN"));
  await api.changes.createPullRequest({
    id: task.id,
    provider: "github",
    remote,
    branch,
    base: "trunk",
    title: "Ship the change",
    body: "",
  });

  // The merge that happens on the forge is what the next refresh reads, and it does not settle:
  // settling stays the user's action, which the client offers on `minimal` state `merged`.
  clis.view(ghView(branch, "MERGED"));
  const merged = await api.changes.pullRequest({ id: task.id, refresh: true });
  expect(merged?.state).toBe("merged");
  const updates = await api.tasks.watch();
  const tasks = await within(updates.next(), "a task list");
  await updates.return?.();
  // The link does not settle the task by itself.
  expect(tasks.value).toMatchObject([{ id: task.id, state: "active" }]);

  await server.restart();
  const restarted = await server.rpc();
  expect(await restarted.changes.pullRequest({ id: task.id })).toMatchObject({
    state: "merged",
    number: 7,
    url: "https://forge.invalid/acme/app/pull/7",
  });
});

test("gitlab opens a merge request with mr create and reads it with mr view", async () => {
  const api = await server.rpc();
  const created = await projectWithBareRemote(api);
  const { task, branch, remote } = await worktreeTask(api, created);
  await api.changes.stage({ id: task.id, paths: "all", staged: true });
  await api.changes.commit({ id: task.id, message: "feat: ship it" });
  await api.changes.push({ id: task.id, remote, branch });

  clis.createdUrl("https://forge.invalid/acme/app/-/merge_requests/12");
  clis.view({
    iid: 12,
    web_url: "https://forge.invalid/acme/app/-/merge_requests/12",
    title: "Ship the change",
    state: "opened",
    draft: false,
    source_branch: branch,
    target_branch: "trunk",
  });
  const request = await api.changes.createPullRequest({
    id: task.id,
    provider: "gitlab",
    remote,
    branch,
    base: "trunk",
    title: "Ship the change",
    body: "A description.\n",
  });
  expect(request).toMatchObject({
    provider: "gitlab",
    host: "forge.invalid",
    number: 12,
    url: "https://forge.invalid/acme/app/-/merge_requests/12",
    state: "open",
    // GitLab reports no per-check list to Corral; the row says so instead of inventing one.
    checks: null,
  });
  expect(clis.calls().map((call) => `${call.command} ${call.argv.join(" ")}`)).toEqual([
    `glab mr create --title Ship the change --description-file - --source-branch ${branch} --target-branch trunk --yes`,
    "glab mr view -F json",
  ]);
  expect(clis.calls()[0]?.stdin).toBe("A description.\n");
});

test("an answer Corral cannot read is a typed response error", async () => {
  const api = await server.rpc();
  const created = await projectWithBareRemote(api);
  const { task, branch, remote } = await worktreeTask(api, created);
  await api.changes.stage({ id: task.id, paths: "all", staged: true });
  await api.changes.commit({ id: task.id, message: "feat: ship it" });
  await api.changes.push({ id: task.id, remote, branch });

  clis.createdUrl("https://forge.invalid/acme/app/pull/7");
  clis.view({ something: "else" });
  await expect(
    api.changes.createPullRequest({
      id: task.id,
      provider: "github",
      remote,
      branch,
      base: "trunk",
      title: "Ship the change",
      body: "",
    }),
  ).resolves.toMatchObject({ number: 7, url: "https://forge.invalid/acme/app/pull/7" });

  // A refresh that cannot parse the answer keeps the link and says unknown.
  clis.view("{not json");
  expect(await api.changes.pullRequest({ id: task.id, refresh: true })).toMatchObject({
    state: "unknown",
    number: 7,
  });
});

test("staging a path outside the task is git's own refusal, and the workspace is unchanged", async () => {
  const api = await server.rpc();
  const created = await projectWithBareRemote(api);
  const { task } = await worktreeTask(api, created);

  await expect(
    api.changes.stage({ id: task.id, paths: ["does-not-exist.ts"], staged: true }),
  ).rejects.toMatchObject({ code: "GIT_FAILED" });
  expect(existsSync(join(task.workspacePath, "does-not-exist.ts"))).toBe(false);
  expect((await api.changes.finish({ id: task.id })).staged).toEqual([]);
});
