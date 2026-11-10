import type { ChangesRemote, Project, Task } from "@corral/protocol/rpc";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { cloneOfOrigin, initRepo, runGit, writeFiles } from "../../test/git-repo.ts";
import { useFakeIssueClis } from "../../test/issue-clis.ts";
import { addProject } from "../../test/project-fixture.ts";
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
  if (task.branch === null) throw new Error("a project worktree must have a branch");
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

test("the task keeps its create-time branch while changes.finish reads the live checkout", async () => {
  const api = await server.rpc();
  const repo = initRepo(join(server.scratchDir, "recorded-branch"), "main");
  const project = await api.projects.add({ path: repo });
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Recorded branch",
    workspace: { type: "main-worktree" },
  });
  expect(task.branch).toBe("main");

  runGit(repo, "branch", "-m", "renamed-outside");
  expect((await api.changes.finish({ id: task.id })).branch).toBe("renamed-outside");
  // Nothing wrote the recorded field: it still says where the task was created.
  expect((await api.tasks.setState({ id: task.id, state: "active" })).branch).toBe("main");
});

test("a detached main-tree task records HEAD at create and reports no branch live", async () => {
  const api = await server.rpc();
  const repo = initRepo(join(server.scratchDir, "detached-branch"), "main");
  runGit(repo, "checkout", "--detach");
  const project = await api.projects.add({ path: repo });
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Detached branch",
    workspace: { type: "main-worktree" },
  });
  // The wire keeps the create-time fact; `null` is the live answer a detached HEAD gives.
  expect(task.branch).toBe("HEAD");
  expect((await api.changes.finish({ id: task.id })).branch).toBeNull();

  runGit(repo, "checkout", "main");
  expect((await api.changes.finish({ id: task.id })).branch).toBe("main");
  expect((await api.tasks.setState({ id: task.id, state: "active" })).branch).toBe("HEAD");
});

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
  // "Unstage all" is a pathspec too: git refuses `restore --staged` without one.
  expect((await api.changes.stage({ id: task.id, paths: "all", staged: false })).staged).toEqual(
    [],
  );
  await api.changes.stage({ id: task.id, paths: "all", staged: true });

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

test("staging and unstaging a rename moves both paths, and the commit records the move", async () => {
  const api = await server.rpc();
  const created = await projectWithBareRemote(api);
  const task = await api.tasks.create({
    projectId: created.project.id,
    title: "Ship the rename",
    workspace: { type: "new-branch" },
  });
  // Test setup for an R row with nothing staged: a worktree-only rename is `D old` plus `?? new`,
  // which the read model lists as two rows. Asking git to record the new path as intent-to-add
  // makes `git diff <base>` see the rename while the index still holds neither change.
  renameSync(join(task.workspacePath, "README.md"), join(task.workspacePath, "renamed.md"));
  runGit(task.workspacePath, "add", "-N", "renamed.md");

  const renamed = (await api.changes.files({ id: task.id })).files.find(
    (file) => file.status === "R",
  );
  expect(renamed).toMatchObject({ path: "renamed.md", oldPath: "README.md" });
  expect((await api.changes.finish({ id: task.id })).staged).toEqual([]);

  const staged = await api.changes.stage({
    id: task.id,
    paths: ["README.md", "renamed.md"],
    staged: true,
  });
  expect(staged.staged).toEqual(["README.md", "renamed.md"]);
  expect(runGit(task.workspacePath, "diff", "--cached", "--name-status").trim()).toBe(
    "R100\tREADME.md\trenamed.md",
  );

  // Unstage after Stage all removes both paths from the index and keeps the worktree rename.
  await api.changes.stage({ id: task.id, paths: "all", staged: true });
  const unstaged = await api.changes.stage({
    id: task.id,
    paths: ["README.md", "renamed.md"],
    staged: false,
  });
  expect(unstaged.staged).toEqual([]);
  expect(runGit(task.workspacePath, "diff", "--cached", "--name-status").trim()).toBe("");
  expect(existsSync(join(task.workspacePath, "README.md"))).toBe(false);
  expect(existsSync(join(task.workspacePath, "renamed.md"))).toBe(true);

  // Stage the selected row again and commit: one rename, and no old file remains in HEAD.
  await api.changes.stage({ id: task.id, paths: ["README.md", "renamed.md"], staged: true });
  const committed = await api.changes.commit({
    id: task.id,
    message: "refactor: rename the readme",
  });
  expect(committed.finish.staged).toEqual([]);
  expect(runGit(task.workspacePath, "ls-tree", "--name-only", "HEAD").trim().split("\n")).toEqual([
    "renamed.md",
  ]);
  expect(existsSync(join(task.workspacePath, "README.md"))).toBe(false);
});

test("a committed rename stages and unstages its new path without the missing old one", async () => {
  const api = await server.rpc();
  const created = await projectWithBareRemote(api);
  const task = await api.tasks.create({
    projectId: created.project.id,
    title: "Ship the committed rename",
    workspace: { type: "new-branch" },
  });
  renameSync(join(task.workspacePath, "README.md"), join(task.workspacePath, "renamed.md"));
  await api.changes.stage({
    id: task.id,
    paths: ["README.md", "renamed.md"],
    staged: true,
  });
  await api.changes.commit({ id: task.id, message: "refactor: rename the readme" });
  const committed = runGit(task.workspacePath, "show", "HEAD:renamed.md");
  writeFiles(task.workspacePath, { "renamed.md": `${committed}HELLO\n` });

  // The read model still shows R README -> renamed against the merge base, so the bar sends both.
  const renamed = (await api.changes.files({ id: task.id })).files.find(
    (file) => file.status === "R",
  );
  expect(renamed).toMatchObject({ path: "renamed.md", oldPath: "README.md" });

  // The old path is in neither the index nor the worktree; it is dropped and the edit stages.
  const staged = await api.changes.stage({
    id: task.id,
    paths: ["README.md", "renamed.md"],
    staged: true,
  });
  expect(staged.staged).toEqual(["renamed.md"]);
  expect(runGit(task.workspacePath, "diff", "--cached", "--name-status").trim()).toBe(
    "M\trenamed.md",
  );

  // A second Stage click from the same row is safe, and Unstage drops the missing old path too.
  const again = await api.changes.stage({
    id: task.id,
    paths: ["README.md", "renamed.md"],
    staged: true,
  });
  expect(again.staged).toEqual(["renamed.md"]);
  const unstaged = await api.changes.stage({
    id: task.id,
    paths: ["README.md", "renamed.md"],
    staged: false,
  });
  expect(unstaged.staged).toEqual([]);
  expect(runGit(task.workspacePath, "diff", "--cached", "--name-status").trim()).toBe("");
  expect(runGit(task.workspacePath, "status", "--porcelain").trim()).toBe("M renamed.md");

  // A path that exists nowhere is still a refusal, not a silent no-op.
  await expect(
    api.changes.stage({ id: task.id, paths: ["README.md"], staged: true }),
  ).rejects.toMatchObject({ code: "GIT_FAILED" });
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

  // A forge-shaped push URL that git rewrites to the local bare repository: the CLI is pointed at
  // the confirmed repository (`--repo`) while nothing leaves the machine.
  const bare = created.origin;
  runGit(created.clone, "remote", "set-url", "origin", "https://forge.invalid/acme/app.git");
  runGit(
    created.clone,
    "config",
    "url." + bare + ".insteadOf",
    "https://forge.invalid/acme/app.git",
  );
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
    `glab mr create --title Ship the change --description-file - --source-branch ${branch} --target-branch trunk --push=false --yes --repo https://forge.invalid/acme/app`,
    "glab mr view 12 -F json --repo https://forge.invalid/acme/app",
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

test("the confirmation and the push follow the remote's pushurl, not its fetch URL", async () => {
  const api = await server.rpc();
  const created = await projectWithBareRemote(api);
  // `origin` fetches from the clone's bare repository and pushes to a different one, the way a
  // fork workflow configures it.
  const pushTarget = join(server.scratchDir, "push-target.git");
  runGit(server.scratchDir, "clone", "--bare", created.origin, pushTarget);
  runGit(created.clone, "remote", "set-url", "--push", "origin", pushTarget);
  const { task, branch, remote } = await worktreeTask(api, created);
  await api.changes.stage({ id: task.id, paths: "all", staged: true });
  const committed = await api.changes.commit({ id: task.id, message: "feat: ship it" });

  // The confirmation's URL is where a push really goes, not where a fetch comes from.
  expect(remote.url).toBe(pushTarget);
  expect(await api.changes.push({ id: task.id, remote, branch })).toMatchObject({
    remote: { name: "origin", url: pushTarget },
  });
  expect(originCommit(pushTarget, branch)).toBe(committed.sha);
  expect(originCommit(created.origin, branch)).toBeUndefined();

  // Confirming the fetch URL is refused: the push URL is the consent.
  await expect(
    api.changes.push({ id: task.id, remote: { name: "origin", url: created.origin }, branch }),
  ).rejects.toMatchObject({
    code: "CHANGES_REMOTE_MISMATCH",
    data: { confirmed: created.origin, actual: pushTarget },
  });
});

test("a push goes to the confirmed remote and leaves the other one empty", async () => {
  const api = await server.rpc();
  const created = await projectWithBareRemote(api);
  const fork = join(server.scratchDir, "fork.git");
  runGit(server.scratchDir, "clone", "--bare", created.origin, fork);
  runGit(created.clone, "remote", "add", "fork", fork);
  const { task, branch, remote } = await worktreeTask(api, created);
  // The branch's upstream names the fork, which is what `resolvePushRemote` reads.
  runGit(task.workspacePath, "config", `branch.${branch}.remote`, "fork");
  const finish = await api.changes.finish({ id: task.id });
  expect(finish.remote).toEqual({ name: "fork", url: fork });
  expect(finish.remotes.map((each) => each.name)).toEqual(["fork", "origin"]);

  await api.changes.stage({ id: task.id, paths: "all", staged: true });
  const committed = await api.changes.commit({ id: task.id, message: "feat: ship it" });
  await api.changes.push({ id: task.id, remote: finish.remote!, branch });
  expect(originCommit(fork, branch)).toBe(committed.sha);
  // The remote the user did not confirm received nothing.
  expect(originCommit(created.origin, branch)).toBeUndefined();
  expect(remote.name).toBe("origin");
});

test("a create refuses a branch the remote has at an older commit", async () => {
  const api = await server.rpc();
  const created = await projectWithBareRemote(api);
  const { task, branch, remote } = await worktreeTask(api, created);
  await api.changes.stage({ id: task.id, paths: "all", staged: true });
  await api.changes.commit({ id: task.id, message: "feat: the first commit" });
  await api.changes.push({ id: task.id, remote, branch });

  // One more commit after the push: the remote's branch is no longer what the dialog would open.
  writeFiles(task.workspacePath, { "src/two.ts": "export const two = 2;\n" });
  await api.changes.stage({ id: task.id, paths: "all", staged: true });
  const second = await api.changes.commit({ id: task.id, message: "feat: the second commit" });
  expect(originCommit(created.origin, branch)).not.toBe(second.sha);

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
  ).rejects.toMatchObject({ code: "CHANGES_PUSH_REQUIRED", data: { remote: "origin", branch } });
  expect(clis.calls()).toEqual([]);
});

test("concurrent refreshes share one CLI read per task", async () => {
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
  clis.calls().length = 0;
  await new Promise<void>((resolve) => setImmediate(resolve)).then(() => undefined);
  const before = clis.calls().length;
  expect(before).toBe(3);

  // A focus event and a tick can ask together; one `pr view` and one `pr checks` answer both.
  const [first, second] = await Promise.all([
    api.changes.pullRequest({ id: task.id, refresh: true }),
    api.changes.pullRequest({ id: task.id, refresh: true }),
  ]);
  expect(first?.state).toBe("open");
  expect(second?.state).toBe("open");
  const after = clis.calls().slice(before);
  expect(after.map((call) => call.argv.slice(0, 2).join(" "))).toEqual(["pr view", "pr checks"]);
});

test("a refresh that cannot read the state drops the checks it cannot confirm", async () => {
  const api = await server.rpc();
  const created = await projectWithBareRemote(api);
  const { task, branch, remote } = await worktreeTask(api, created);
  await api.changes.stage({ id: task.id, paths: "all", staged: true });
  await api.changes.commit({ id: task.id, message: "feat: ship it" });
  await api.changes.push({ id: task.id, remote, branch });
  clis.view(ghView(branch, "OPEN"));
  clis.checks([
    { bucket: "pass", name: "build" },
    { bucket: "fail", name: "deploy" },
  ]);
  const request = await api.changes.createPullRequest({
    id: task.id,
    provider: "github",
    remote,
    branch,
    base: "trunk",
    title: "Ship the change",
    body: "",
  });
  expect(request.checks).toMatchObject({ total: 2, passing: 1, failing: 1 });

  clis.fail(1, "dial tcp: lookup forge.invalid: no such host");
  const unreadable = await api.changes.pullRequest({ id: task.id, refresh: true });
  expect(unreadable).toMatchObject({ state: "unknown", checks: null });
  expect(await api.changes.pullRequest({ id: task.id })).toMatchObject({
    state: "unknown",
    checks: null,
  });
});

test("a repository with no remote refuses the push with CHANGES_NO_REMOTE", async () => {
  const api = await server.rpc();
  const project = (await addProject(server)).project;
  const task = await api.tasks.create({
    projectId: project.id,
    title: "No remote here",
    workspace: { type: "new-branch" },
  });
  const finish = await api.changes.finish({ id: task.id });
  if (task.branch === null) throw new Error("a project worktree must have a branch");
  expect(finish.remote).toBeNull();
  expect(finish.remotes).toEqual([]);
  await expect(
    api.changes.push({
      id: task.id,
      remote: { name: "origin", url: "/tmp/nowhere.git" },
      branch: task.branch,
    }),
  ).rejects.toMatchObject({ code: "CHANGES_NO_REMOTE", data: { branch: task.branch } });
});

test("a missing CLI and a failing CLI are each a typed refusal", async () => {
  const api = await server.rpc();
  const created = await projectWithBareRemote(api);
  const { task, branch, remote } = await worktreeTask(api, created);
  await api.changes.stage({ id: task.id, paths: "all", staged: true });
  await api.changes.commit({ id: task.id, message: "feat: ship it" });
  await api.changes.push({ id: task.id, remote, branch });
  clis.withoutIssueClis();
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
  ).rejects.toMatchObject({ code: "CHANGES_CLI_MISSING", data: { command: "gh" } });
});

test("a CLI failure is a sentence, and an unreadable answer is CHANGES_RESPONSE_INVALID", async () => {
  const api = await server.rpc();
  const created = await projectWithBareRemote(api);
  const { task, branch, remote } = await worktreeTask(api, created);
  await api.changes.stage({ id: task.id, paths: "all", staged: true });
  await api.changes.commit({ id: task.id, message: "feat: ship it" });
  await api.changes.push({ id: task.id, remote, branch });

  clis.fail(1, "HTTP 404: Not Found (https://forge.invalid/acme/app)");
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
    code: "CHANGES_CLI_FAILED",
    data: { provider: "github", message: "The request was not found." },
  });

  clis.answer({});
  clis.createdUrl("no url in this output");
  clis.view("{not json");
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
  ).rejects.toMatchObject({ code: "CHANGES_RESPONSE_INVALID", data: { provider: "github" } });
});

test("a parseable push URL points the CLI at the confirmed repository", async () => {
  const api = await server.rpc();
  const created = await projectWithBareRemote(api);
  const bare = created.origin;
  runGit(created.clone, "remote", "set-url", "origin", "https://forge.invalid/acme/app.git");
  runGit(
    created.clone,
    "config",
    "url." + bare + ".insteadOf",
    "https://forge.invalid/acme/app.git",
  );
  const { task, branch, remote } = await worktreeTask(api, created);
  // `git remote get-url --push` expands `insteadOf`, so the confirmation names the address a push
  // really reaches; `--repo` comes from the configured URL, which is what names the repository.
  expect(remote.url).toBe(bare);
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
  expect(clis.calls()[0]?.argv).toContain("--repo");
  expect(clis.calls()[0]?.argv).toContain("forge.invalid/acme/app");
  // `--repo` needs the request positionally (`gh pr view 7 --repo …`, probed in
  // `test/contracts/gh-pr-argv.contract.ts`); the create's own URL gives the number.
  expect(clis.calls()[1]?.argv).toEqual([
    "pr",
    "view",
    "7",
    "--json",
    "number,url,title,state,isDraft,baseRefName,headRefName,statusCheckRollup",
    "--repo",
    "forge.invalid/acme/app",
  ]);
  expect(clis.calls()[2]?.argv).toEqual([
    "pr",
    "checks",
    "7",
    "--json",
    "bucket,name,state",
    "--repo",
    "forge.invalid/acme/app",
  ]);

  // The row keeps the repository (host and path in one value) and the number, so a refresh reads
  // the same request on the same host without the remote.
  expect(await api.changes.pullRequest({ id: task.id })).toMatchObject({
    host: "forge.invalid",
    repository: "forge.invalid/acme/app",
  });
  const before = clis.calls().length;
  expect(await api.changes.pullRequest({ id: task.id, refresh: true })).toMatchObject({
    state: "open",
  });
  expect(
    clis
      .calls()
      .slice(before)
      .map((call) => call.argv),
  ).toEqual([
    [
      "pr",
      "view",
      "7",
      "--json",
      "number,url,title,state,isDraft,baseRefName,headRefName,statusCheckRollup",
      "--repo",
      "forge.invalid/acme/app",
    ],
    ["pr", "checks", "7", "--json", "bucket,name,state", "--repo", "forge.invalid/acme/app"],
  ]);
  for (const call of clis.calls()) {
    expect([call.command, ...call.argv, call.cwd].join(" ")).not.toMatch(
      /github\.com|gitlab\.com|ghe\.com/,
    );
  }
});
