import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import { useFakeIssueClis } from "../../test/issue-clis.ts";
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
        "--json=number,title,body",
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
  clis.answer({ iid: 7, title: "Issue title", description: "Original issue body" });
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

test("a self-hosted host needs its provider named; then GitLab and GitHub Enterprise are read on that host", async () => {
  const { project } = await addProject(server);
  const api = await server.rpc();
  const gitlabUrl = "https://gitlab.example.com/group/project/-/issues/3";

  await expect(
    api.projects.resolveIssue({ projectId: project.id, url: gitlabUrl }),
  ).rejects.toMatchObject({
    code: "ISSUE_PROVIDER_REQUIRED",
    data: { host: "gitlab.example.com" },
  });
  expect(clis.calls()).toEqual([]);

  clis.answer({ iid: 3, title: "Self hosted", description: "body" });
  expect(
    await api.projects.resolveIssue({ projectId: project.id, url: gitlabUrl, provider: "gitlab" }),
  ).toMatchObject({ provider: "gitlab", host: "gitlab.example.com", url: gitlabUrl });

  clis.answer({ number: 9, title: "Enterprise", body: "" });
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
  expect(clis.calls().map((call) => [call.command, call.argv])).toEqual([
    ["glab", ["issue", "view", gitlabUrl, "--output=json"]],
    [
      "gh",
      [
        "issue",
        "view",
        "https://ghe.example.com/acme/app/issues/9",
        "--repo=ghe.example.com/acme/app",
        "--json=number,title,body",
      ],
    ],
  ]);
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

  clis.answer({ number: 2, title: "Wrong issue", body: "" });
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

  clis.fail(1, "401 Unauthorized: run glab auth login --hostname gitlab.example.com");
  await expect(
    api.projects.resolveIssue({
      projectId: project.id,
      url: "https://gitlab.example.com/group/project/-/issues/1",
      provider: "gitlab",
    }),
  ).rejects.toMatchObject({ code: "ISSUE_AUTH_REQUIRED", data: { provider: "gitlab" } });

  clis.fail(1, "dial tcp: lookup github.com: no such host");
  await expect(api.projects.resolveIssue({ projectId: project.id, url })).rejects.toMatchObject({
    code: "ISSUE_FETCH_FAILED",
    data: { provider: "github", message: expect.stringContaining("no such host") },
  });

  clis.fail(1, "x".repeat(5000));
  const error = await api.projects.resolveIssue({ projectId: project.id, url }).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toMatchObject({ code: "ISSUE_FETCH_FAILED" });
  const data = typeof error === "object" && error !== null ? Reflect.get(error, "data") : undefined;
  const message =
    typeof data === "object" && data !== null ? Reflect.get(data, "message") : undefined;
  expect(typeof message).toBe("string");
  expect(String(message).length).toBeLessThanOrEqual(400);

  clis.hugeOutput();
  await expect(api.projects.resolveIssue({ projectId: project.id, url })).rejects.toMatchObject({
    code: "ISSUE_FETCH_FAILED",
    data: { provider: "github", message: expect.stringContaining("too much output") },
  });
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
