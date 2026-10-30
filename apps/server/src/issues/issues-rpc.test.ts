import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { useFakeIssueClis } from "../../test/issue-clis.ts";
import { runGit } from "../../test/git-repo.ts";
import { addProject } from "../../test/project-fixture.ts";
import { useServer, within } from "../../test/server-fixture.ts";

const server = useServer();
const clis = useFakeIssueClis();

const firstTaskList = async (api: Awaited<ReturnType<typeof server.rpc>>) => {
  const updates = await api.tasks.watch();
  const value = (await within(updates.next(), "a task list")).value;
  await updates.return?.();
  return value;
};

test("a GitHub issue resolves with only a read command; its title becomes the task title and its source survives a restart", async () => {
  const { project } = await addProject(server);
  clis.answer({
    number: 42,
    title: "Fix the login bug",
    body: "Steps:\n$(touch pwned)\n",
    url: "https://github.com/acme/app/issues/42",
  });
  const api = await server.rpc();

  const source = await api.projects.resolveIssue({
    projectId: project.id,
    url: "https://github.com/acme/app/issues/42#issuecomment-1",
  });

  expect(source).toEqual({
    provider: "github",
    host: "github.com",
    repository: "acme/app",
    number: 42,
    url: "https://github.com/acme/app/issues/42",
    title: "Fix the login bug",
    body: "Steps:\n$(touch pwned)\n",
    fetchedAt: expect.any(Number),
  });
  expect(clis.calls()).toEqual([
    {
      command: "gh",
      argv: [
        "issue",
        "view",
        "https://github.com/acme/app/issues/42",
        "--repo=github.com/acme/app",
        "--json=number,title,body,url",
      ],
      cwd: project.path,
    },
  ]);

  const task = await api.tasks.create({
    projectId: project.id,
    source,
    workspace: { type: "new-branch" },
  });
  expect(task).toMatchObject({
    title: "Fix the login bug",
    branch: "fix-the-login-bug",
    source,
  });
  expect(existsSync(join(task.workspacePath, "pwned"))).toBe(false);
  expect(task.branch).not.toContain("pwned");
  expect(await firstTaskList(api)).toEqual([task]);

  await server.restart();
  const restarted = await server.rpc();
  expect(await firstTaskList(restarted)).toEqual([task]);
});

test("a GitLab issue reads description as text, and a locally edited title keeps the original issue snapshot", async () => {
  const { project } = await addProject(server);
  clis.answer({
    iid: 7,
    title: "Issue title",
    description: "Original issue body",
    web_url: "https://gitlab.com/group/sub/project/-/issues/7",
  });
  const api = await server.rpc();

  const source = await api.projects.resolveIssue({
    projectId: project.id,
    url: "https://gitlab.com/group/sub/project/-/issues/7",
  });
  expect(source).toMatchObject({
    provider: "gitlab",
    host: "gitlab.com",
    repository: "group/sub/project",
    number: 7,
    url: "https://gitlab.com/group/sub/project/-/issues/7",
    title: "Issue title",
    body: "Original issue body",
  });
  expect(clis.calls()).toEqual([
    {
      command: "glab",
      argv: ["issue", "view", "https://gitlab.com/group/sub/project/-/issues/7", "--output=json"],
      cwd: project.path,
    },
  ]);

  const task = await api.tasks.create({
    projectId: project.id,
    title: "My local wording",
    source,
    workspace: { type: "main-worktree" },
  });
  expect(task.title).toBe("My local wording");
  expect(task.source).toEqual(source);

  await server.restart();
  expect(await firstTaskList(await server.rpc())).toEqual([task]);
});

test("a direct GitLab work_items URL is accepted and converted to the proven issue-view form", async () => {
  const { project } = await addProject(server);
  const workItemUrl = "https://gitlab.com/group/project/-/work_items/5";
  const issueUrl = "https://gitlab.com/group/project/-/issues/5";
  clis.answer({
    iid: 5,
    title: "Work item alias",
    description: "body",
    web_url: workItemUrl,
  });
  const api = await server.rpc();

  const source = await api.projects.resolveIssue({ projectId: project.id, url: workItemUrl });
  expect(source).toMatchObject({
    provider: "gitlab",
    repository: "group/project",
    number: 5,
    url: issueUrl,
  });
  expect(clis.calls()).toEqual([
    {
      command: "glab",
      argv: ["issue", "view", issueUrl, "--output=json"],
      cwd: project.path,
    },
  ]);
});

test("a self-hosted host needs its provider named and a trusted source; then GitLab and GitHub Enterprise are read on that host", async () => {
  const { project, repo } = await addProject(server);
  runGit(repo, "remote", "add", "origin", "https://gitlab.example.com/group/project.git");
  const api = await server.rpc();
  const gitlabUrl = "https://gitlab.example.com/group/project/-/issues/3";

  await expect(
    api.projects.resolveIssue({ projectId: project.id, url: gitlabUrl }),
  ).rejects.toMatchObject({
    code: "ISSUE_PROVIDER_REQUIRED",
    data: { host: "gitlab.example.com" },
  });
  expect(clis.calls()).toEqual([]);

  clis.answer({
    iid: 3,
    title: "Self hosted",
    description: "body",
    web_url: gitlabUrl,
  });
  expect(
    await api.projects.resolveIssue({ projectId: project.id, url: gitlabUrl, provider: "gitlab" }),
  ).toMatchObject({ provider: "gitlab", host: "gitlab.example.com", url: gitlabUrl });

  clis.answer({
    number: 9,
    title: "Enterprise",
    body: "",
    url: "https://ghe.example.com/acme/app/issues/9",
  });
  vi.stubEnv("GH_HOST", "ghe.example.com");
  const enterprise = await api.projects.resolveIssue({
    projectId: project.id,
    url: "https://ghe.example.com/acme/app/issues/9",
    provider: "github",
  });
  expect(enterprise).toMatchObject({
    provider: "github",
    host: "ghe.example.com",
    repository: "acme/app",
    url: "https://ghe.example.com/acme/app/issues/9",
  });
  const portedUrl = "https://gitlab.example.com:8443/group/project/-/issues/4";
  runGit(repo, "remote", "add", "secure", "https://gitlab.example.com:8443/group/project.git");
  clis.answer({
    iid: 4,
    title: "Ported",
    description: "body",
    web_url: portedUrl,
  });
  expect(
    await api.projects.resolveIssue({
      projectId: project.id,
      url: portedUrl,
      provider: "gitlab",
    }),
  ).toMatchObject({ host: "gitlab.example.com:8443", number: 4 });
  await expect(
    api.projects.resolveIssue({
      projectId: project.id,
      url: "https://gitlab.example.com:9443/group/project/-/issues/4",
      provider: "gitlab",
    }),
  ).rejects.toMatchObject({
    code: "ISSUE_HOST_UNTRUSTED",
    data: { provider: "gitlab", host: "gitlab.example.com:9443" },
  });
  expect(clis.calls().map((call) => [call.command, call.argv])).toEqual([
    ["glab", ["issue", "view", gitlabUrl, "--output=json"]],
    [
      "gh",
      [
        "issue",
        "view",
        "https://ghe.example.com/acme/app/issues/9",
        "--repo=ghe.example.com/acme/app",
        "--json=number,title,body,url",
      ],
    ],
    ["glab", ["issue", "view", portedUrl, "--output=json"]],
  ]);
});

test("an arbitrary provider host is untrusted before any CLI runs, even with an enterprise token", async () => {
  const { project } = await addProject(server);
  vi.stubEnv("GH_ENTERPRISE_TOKEN", "SENTINEL_ENTERPRISE_TOKEN");
  const api = await server.rpc();

  await expect(
    api.projects.resolveIssue({
      projectId: project.id,
      url: "https://attacker.example/acme/app/issues/1",
      provider: "github",
    }),
  ).rejects.toMatchObject({
    code: "ISSUE_HOST_UNTRUSTED",
    data: { provider: "github", host: "attacker.example" },
  });
  expect(clis.calls()).toEqual([]);
});

test("a local Windows-looking remote never authorizes host c", async () => {
  const { project, repo } = await addProject(server);
  runGit(repo, "remote", "add", "origin", "C:\\repo");
  const api = await server.rpc();

  await expect(
    api.projects.resolveIssue({
      projectId: project.id,
      url: "https://c/acme/app/issues/1",
      provider: "github",
    }),
  ).rejects.toMatchObject({
    code: "ISSUE_HOST_UNTRUSTED",
    data: { provider: "github", host: "c" },
  });
  expect(clis.calls()).toEqual([]);
});

test("a project GitLab host does not forward a global GitHub enterprise token", async () => {
  const { project, repo } = await addProject(server);
  runGit(repo, "remote", "add", "origin", "https://gitlab.example.com/group/project.git");
  clis.answer({
    number: 1,
    title: "Vendor safe",
    body: "",
    url: "https://gitlab.example.com/acme/app/issues/1",
  });
  vi.stubEnv("GH_TOKEN", "SENTINEL_GH_TOKEN");
  vi.stubEnv("GH_ENTERPRISE_TOKEN", "SENTINEL_ENTERPRISE_TOKEN");
  vi.stubEnv("GITHUB_ENTERPRISE_TOKEN", "SENTINEL_GITHUB_ENTERPRISE_TOKEN");
  vi.stubEnv("FAKE_ISSUE_FORBID_ENV", "GH_TOKEN,GH_ENTERPRISE_TOKEN,GITHUB_ENTERPRISE_TOKEN");
  const api = await server.rpc();

  await expect(
    api.projects.resolveIssue({
      projectId: project.id,
      url: "https://gitlab.example.com/acme/app/issues/1",
      provider: "github",
    }),
  ).resolves.toMatchObject({ title: "Vendor safe" });
});

test("an explicit GH_HOST binding keeps the matching enterprise token", async () => {
  const { project } = await addProject(server);
  clis.answer({
    number: 2,
    title: "Bound",
    body: "",
    url: "https://ghe.example.com/acme/app/issues/2",
  });
  vi.stubEnv("GH_HOST", "ghe.example.com");
  vi.stubEnv("GH_TOKEN", "SENTINEL_GH_TOKEN");
  vi.stubEnv("GH_ENTERPRISE_TOKEN", "SENTINEL_ENTERPRISE_TOKEN");
  vi.stubEnv("FAKE_ISSUE_REQUIRE_ENV", "GH_TOKEN,GH_ENTERPRISE_TOKEN");
  const api = await server.rpc();

  await expect(
    api.projects.resolveIssue({
      projectId: project.id,
      url: "https://ghe.example.com/acme/app/issues/2",
      provider: "github",
    }),
  ).resolves.toMatchObject({ title: "Bound" });
});

test("a remote-only github.localhost host strips GH_TOKEN too", async () => {
  const { project, repo } = await addProject(server);
  runGit(repo, "remote", "add", "origin", "git@github.localhost:acme/app.git");
  const url = "https://github.localhost/acme/app/issues/1";
  clis.answer({ number: 1, title: "Local host safe", body: "", url });
  vi.stubEnv("GH_TOKEN", "SENTINEL_GH_TOKEN");
  vi.stubEnv("GH_ENTERPRISE_TOKEN", "SENTINEL_GH_ENTERPRISE_TOKEN");
  vi.stubEnv("FAKE_ISSUE_FORBID_ENV", "GH_TOKEN,GH_ENTERPRISE_TOKEN");
  const api = await server.rpc();

  await expect(
    api.projects.resolveIssue({ projectId: project.id, url, provider: "github" }),
  ).resolves.toMatchObject({ title: "Local host safe" });
});

test("a GitLab CLI never receives GitHub token variables", async () => {
  const { project } = await addProject(server);
  const url = "https://gitlab.com/group/project/-/issues/6";
  clis.answer({
    iid: 6,
    title: "No cross provider tokens",
    description: "",
    web_url: url,
  });
  vi.stubEnv("GH_TOKEN", "SENTINEL_GH_TOKEN");
  vi.stubEnv("GH_ENTERPRISE_TOKEN", "SENTINEL_ENTERPRISE_TOKEN");
  vi.stubEnv("FAKE_ISSUE_FORBID_ENV", "GH_TOKEN,GH_ENTERPRISE_TOKEN");
  const api = await server.rpc();

  await expect(api.projects.resolveIssue({ projectId: project.id, url })).resolves.toMatchObject({
    title: "No cross provider tokens",
  });
});

test("a GitHub issue on a nonstandard port is refused before any CLI runs", async () => {
  const { project, repo } = await addProject(server);
  runGit(repo, "remote", "add", "origin", "https://ghe.example.com:8443/acme/app.git");
  const api = await server.rpc();

  await expect(
    api.projects.resolveIssue({
      projectId: project.id,
      url: "https://ghe.example.com:8443/acme/app/issues/9",
      provider: "github",
    }),
  ).rejects.toMatchObject({
    code: "ISSUE_UNSUPPORTED_PORT",
    data: { provider: "github", host: "ghe.example.com:8443" },
  });
  expect(clis.calls()).toEqual([]);
});

test("untrusted URLs fail before any CLI runs", async () => {
  const { project } = await addProject(server);
  const api = await server.rpc();
  const urls = [
    "javascript:alert(1)",
    "https://user:pass@github.com/acme/app/issues/1",
    "https://github.com/acme/app/pull/1",
    "https://github.com/-acme/app/issues/1",
    "https://github.com/acme/app/issues/1%2F..",
    "https://gitlab.com/group/project/issues/1",
  ];
  for (const url of urls) {
    // oxlint-disable-next-line no-await-in-loop -- one URL at a time keeps the failure readable
    await expect(api.projects.resolveIssue({ projectId: project.id, url })).rejects.toMatchObject({
      code: "ISSUE_URL_INVALID",
      data: { message: expect.any(String) },
    });
  }
  expect(clis.calls()).toEqual([]);
});

test("malformed or mismatched CLI output is a domain error, and no task is invented", async () => {
  const { project } = await addProject(server);
  const api = await server.rpc();

  clis.answer("{");
  await expect(
    api.projects.resolveIssue({
      projectId: project.id,
      url: "https://github.com/acme/app/issues/1",
    }),
  ).rejects.toMatchObject({ code: "ISSUE_RESPONSE_INVALID", data: { provider: "github" } });

  clis.answer({
    number: 2,
    title: "Wrong issue",
    body: "",
    url: "https://github.com/acme/app/issues/2",
  });
  await expect(
    api.projects.resolveIssue({
      projectId: project.id,
      url: "https://github.com/acme/app/issues/1",
    }),
  ).rejects.toMatchObject({ code: "ISSUE_RESPONSE_INVALID", data: { provider: "github" } });

  expect(await firstTaskList(api)).toEqual([]);
});

test("auth, network and output-size failures stay bounded and typed", async () => {
  const { project } = await addProject(server);
  const api = await server.rpc();
  const url = "https://github.com/acme/app/issues/1";

  clis.fail(4, "To get started with GitHub CLI, please run: gh auth login");
  await expect(api.projects.resolveIssue({ projectId: project.id, url })).rejects.toMatchObject({
    code: "ISSUE_AUTH_REQUIRED",
    data: { provider: "github" },
  });

  clis.fail(1, "401 Unauthorized: run glab auth login --hostname gitlab.com");
  await expect(
    api.projects.resolveIssue({
      projectId: project.id,
      url: "https://gitlab.com/group/project/-/issues/1",
    }),
  ).rejects.toMatchObject({ code: "ISSUE_AUTH_REQUIRED", data: { provider: "gitlab" } });

  clis.fail(1, "dial tcp: lookup github.com: no such host");
  await expect(api.projects.resolveIssue({ projectId: project.id, url })).rejects.toMatchObject({
    code: "ISSUE_FETCH_FAILED",
    data: { provider: "github", message: "Could not reach the issue host." },
  });

  clis.fail(1, "Could not resolve to a Repository with the number of 401");
  await expect(api.projects.resolveIssue({ projectId: project.id, url })).rejects.toMatchObject({
    code: "ISSUE_FETCH_FAILED",
    data: { provider: "github", message: "The issue was not found." },
  });

  clis.fail(1, "Authorization: Bearer SENTINEL_SECRET_42");
  const error = await api.projects.resolveIssue({ projectId: project.id, url }).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toMatchObject({
    code: "ISSUE_FETCH_FAILED",
    data: { provider: "github", message: "The issue tool failed." },
  });
  expect(JSON.stringify(error)).not.toContain("SENTINEL_SECRET_42");

  clis.hugeOutput();
  await expect(api.projects.resolveIssue({ projectId: project.id, url })).rejects.toMatchObject({
    code: "ISSUE_FETCH_FAILED",
    data: { provider: "github", message: expect.stringContaining("too much output") },
  });
});

test("inherited native CLI debug variables never reach the child", async () => {
  const { project } = await addProject(server);
  clis.answer({
    number: 1,
    title: "Debug safe",
    body: "",
    url: "https://github.com/acme/app/issues/1",
  });
  vi.stubEnv("GH_DEBUG", "api");
  vi.stubEnv("GLAB_DEBUG", "true");
  vi.stubEnv("GIT_TRACE", "1");
  const api = await server.rpc();

  await expect(
    api.projects.resolveIssue({
      projectId: project.id,
      url: "https://github.com/acme/app/issues/1",
    }),
  ).resolves.toMatchObject({ title: "Debug safe" });
});

test("without gh or glab, resolving says which command is missing and manual creation still works", async () => {
  const { project } = await addProject(server);
  clis.withoutIssueClis();
  const api = await server.rpc();

  await expect(
    api.projects.resolveIssue({
      projectId: project.id,
      url: "https://github.com/acme/app/issues/1",
    }),
  ).rejects.toMatchObject({ code: "ISSUE_CLI_MISSING", data: { command: "gh" } });

  const task = await api.tasks.create({
    projectId: project.id,
    title: "Manual task",
    workspace: { type: "main-worktree" },
  });
  expect(task).toMatchObject({ title: "Manual task" });
  expect(task.source).toBeUndefined();
});

test("a slow CLI is killed at the bounded timeout and reported as a timeout", async () => {
  const { project } = await addProject(server);
  vi.stubEnv("CORRAL_ISSUE_IMPORT_TIMEOUT_MS", "300");
  await server.restart();
  const pidFile = clis.hang();
  const api = await server.rpc();

  await expect(
    api.projects.resolveIssue({
      projectId: project.id,
      url: "https://github.com/acme/app/issues/1",
    }),
  ).rejects.toMatchObject({ code: "ISSUE_FETCH_TIMEOUT", data: { provider: "github" } });

  const pid = Number(readFileSync(pidFile, "utf8"));
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(/ESRCH/));
});
