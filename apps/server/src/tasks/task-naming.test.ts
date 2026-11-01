import { ConfigState } from "@corral/protocol/config";
import { Task } from "@corral/protocol/rpc";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { useFakeNaming } from "../../test/fake-naming.ts";
import { runGit } from "../../test/git-repo.ts";
import { addProject } from "../../test/project-fixture.ts";
import { useServer, within } from "../../test/server-fixture.ts";
import { parseConfigFile } from "../config/config-file.ts";

const server = useServer();
const fake = useFakeNaming();
// The profile's environment reference is resolved for every naming run.
beforeEach(() => vi.stubEnv("FAKE_NAMING_TOKEN", "gateway-secret"));
afterEach(() => vi.restoreAllMocks());

const PROFILE = `
[profiles.gateway]
name = "Claude via gateway"
agent = "claude"
env = [{ targetName = "ANTHROPIC_AUTH_TOKEN", fromEnv = "FAKE_NAMING_TOKEN" }]

[naming]
profile = "gateway"
timeout-seconds = 1
`;

/** Writes the config and waits until the server's watcher has read exactly that state. */
async function configure(text: string): Promise<void> {
  const expected = JSON.stringify(parseConfigFile(text, server.dataDir).config);
  const api = await server.rpc();
  const updates = await api.config.watch();
  try {
    await mkdir(server.configDir, { recursive: true });
    await writeFile(join(server.configDir, "config.toml"), text);
    const nextState = async () =>
      ConfigState.parse((await within(updates.next(), "the config to be read")).value);
    for (;;) {
      // oxlint-disable-next-line no-await-in-loop -- one state per push is the point
      const state = await nextState();
      if (JSON.stringify(state.config) === expected) return;
    }
  } finally {
    await updates.return?.();
  }
}

async function createWorktreeTask(prompt: string) {
  const { project } = await addProject(server);
  const api = await server.rpc();
  return api.tasks.create({ projectId: project.id, prompt, workspace: { type: "new-branch" } });
}

const captureWarnings = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);

/** Captures warnings and resolves once one contains `text`, so a test can wait for a late run. */
function waitForWarning(text: string): { done: Promise<void> } {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  vi.spyOn(console, "warn").mockImplementation((...args) => {
    if (args.join(" ").includes(text)) finish();
  });
  return { done };
}

test("a main-worktree task returns with its seed title and gets the generated title on the watch", async () => {
  await configure(PROFILE);
  vi.stubEnv("FAKE_NAMING_OUTPUT", JSON.stringify({ title: "Add OAuth login" }));
  vi.stubEnv("FAKE_NAMING_DELAY_MS", "100");
  vi.stubEnv("FAKE_NAMING_TOKEN", "gateway-secret");
  const { project, repo } = await addProject(server);
  const api = await server.rpc();
  const updates = await api.tasks.watch();
  const next = async (): Promise<Task[]> =>
    Task.array().parse((await within(updates.next(), "a tasks update")).value);
  try {
    expect(await next()).toEqual([]);
    const created = await api.tasks.create({
      projectId: project.id,
      prompt: "Add OAuth login to the app",
      workspace: { type: "main-worktree" },
    });

    // The response is the seed task; the generated title is a later watch update.
    expect(created).toMatchObject({
      title: "Add OAuth login to the app",
      titleSource: "seed",
      workspacePath: repo,
      ownsWorktree: false,
    });
    expect(await next()).toEqual([created]);
    expect((await next())[0]).toMatchObject({
      id: created.id,
      title: "Add OAuth login",
      titleSource: "generated",
      workspacePath: repo,
    });
  } finally {
    await updates.return?.();
  }

  const [run] = await fake.runs();
  expect(run).toMatchObject({ agent: "claude" });
  // The naming call ran in a temporary directory, not in the repository, and it is gone.
  expect(run!.cwd.startsWith(repo)).toBe(false);
  expect(existsSync(run!.cwd)).toBe(false);
  // The profile's environment reference was resolved for the naming call.
  expect(run!.env.ANTHROPIC_AUTH_TOKEN).toBe("gateway-secret");
  expect(run!.argv).toEqual(
    expect.arrayContaining(["-p", "--tools", "", "--no-session-persistence"]),
  );
  expect(run!.argv.join("\n")).toContain("Add OAuth login to the app");
});

test("a worktree task waits for naming, then branches and names the directory from the title", async () => {
  await configure(PROFILE);
  vi.stubEnv("FAKE_NAMING_OUTPUT", JSON.stringify({ title: "Add OAuth login" }));
  vi.stubEnv("FAKE_NAMING_DELAY_MS", "150");

  const task = await createWorktreeTask("Add OAuth login to the app");

  const root = join(server.dataDir, "worktrees", "app");
  expect(task).toMatchObject({
    title: "Add OAuth login",
    titleSource: "generated",
    branch: "add-oauth-login",
    workspacePath: join(root, "add-oauth-login"),
    ownsWorktree: true,
  });
  // The seed's slug never reached disk.
  expect(existsSync(join(root, "add-oauth-login-to-the-app"))).toBe(false);
  expect(runGit(task.workspacePath, "branch", "--show-current").trim()).toBe("add-oauth-login");

  const [run] = await fake.runs();
  // Title mode asks for a title only.
  expect(run!.argv.join("\n")).not.toContain('"branch"');
});

test("generated slug mode names the branch and worktree from the response, under the prefix", async () => {
  await configure(`${PROFILE}\n[tasks]\nslug-mode = "generated"\nbranch-prefix = "corral/"\n`);
  vi.stubEnv(
    "FAKE_NAMING_OUTPUT",
    JSON.stringify({ title: "Add OAuth login", branch: "corral/oauth-sso", worktree: "oauth-sso" }),
  );

  const task = await createWorktreeTask("Add OAuth login to the app");

  const path = join(server.dataDir, "worktrees", "app", "oauth-sso");
  expect(task).toMatchObject({
    title: "Add OAuth login",
    titleSource: "generated",
    branch: "corral/oauth-sso",
    workspacePath: path,
  });
  // The path is the generated slug exactly: nothing random, no seed suffix.
  expect(task.workspacePath).toBe(path);
  expect(runGit(task.workspacePath, "branch", "--show-current").trim()).toBe("corral/oauth-sso");

  const [run] = await fake.runs();
  expect(run!.argv.join("\n")).toContain('"branch"');
  expect(run!.argv.join("\n")).toContain('"worktree"');
});

test("garbage output keeps the seed title and the title's slug", async () => {
  await configure(`${PROFILE}\n[tasks]\nslug-mode = "generated"\n`);
  const warn = captureWarnings();
  vi.stubEnv("FAKE_NAMING_OUTPUT", "I could not name this.");

  const task = await createWorktreeTask("Fix the login bug");

  expect(task).toMatchObject({
    title: "Fix the login bug",
    titleSource: "seed",
    branch: "fix-the-login-bug",
  });
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("no JSON object"));
  // The reason is logged; the prompt never is.
  expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("Fix the login bug"));
});

test("a generated branch with no usable slug falls back to the title's slug", async () => {
  await configure(`${PROFILE}\n[tasks]\nslug-mode = "generated"\n`);
  const warn = captureWarnings();
  vi.stubEnv(
    "FAKE_NAMING_OUTPUT",
    JSON.stringify({ title: "Add OAuth login", branch: "!!!", worktree: "!!!" }),
  );

  const task = await createWorktreeTask("Add OAuth login to the app");

  expect(task).toMatchObject({
    title: "Add OAuth login",
    titleSource: "generated",
    branch: "add-oauth-login",
  });
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("no usable slug"));
});

test("a generated branch and worktree that disagree fall back to the title's slug", async () => {
  await configure(`${PROFILE}\n[tasks]\nslug-mode = "generated"\n`);
  const warn = captureWarnings();
  vi.stubEnv(
    "FAKE_NAMING_OUTPUT",
    JSON.stringify({ title: "Add OAuth login", branch: "oauth-sso", worktree: "sign-in" }),
  );

  const task = await createWorktreeTask("Add OAuth login to the app");

  expect(task).toMatchObject({
    title: "Add OAuth login",
    titleSource: "generated",
    branch: "add-oauth-login",
  });
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("branch and worktree disagree"));
});

test("a naming run that outlives the timeout keeps the seed and the worktree is still created", async () => {
  await configure(PROFILE);
  const warn = captureWarnings();
  // The configured timeout is 1s; the fake would take 5s.
  vi.stubEnv("FAKE_NAMING_DELAY_MS", "5000");

  const started = Date.now();
  const task = await within(createWorktreeTask("Fix the login bug"), "the task");

  expect(Date.now() - started).toBeLessThan(5000);
  expect(task).toMatchObject({
    title: "Fix the login bug",
    titleSource: "seed",
    branch: "fix-the-login-bug",
  });
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("no answer within 1s"));
});

test("a main-worktree create returns before a slow naming run finishes", async () => {
  await configure(PROFILE);
  const { done } = waitForWarning("no answer within 1s");
  vi.stubEnv("FAKE_NAMING_DELAY_MS", "5000");
  const { project } = await addProject(server);
  const api = await server.rpc();

  const started = Date.now();
  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "Fix the login bug",
    workspace: { type: "main-worktree" },
  });

  // The response is the seed task, not the 1s timeout's result.
  expect(Date.now() - started).toBeLessThan(1000);
  expect(task).toMatchObject({ title: "Fix the login bug", titleSource: "seed" });
  await within(done, "the naming run to time out");
});

test("a missing naming executable keeps the seed instead of failing the task", async () => {
  await configure('[naming]\nagent = "codex"\ntimeout-seconds = 1\n');
  const warn = captureWarnings();

  const task = await createWorktreeTask("Fix the login bug");

  expect(task).toMatchObject({
    title: "Fix the login bug",
    titleSource: "seed",
    branch: "fix-the-login-bug",
  });
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("no executable codex"));
  expect(await fake.runs()).toEqual([]);
});

test("a rename during generation wins over the generated title", async () => {
  await configure(PROFILE);
  vi.stubEnv("FAKE_NAMING_OUTPUT", JSON.stringify({ title: "Generated name" }));
  vi.stubEnv("FAKE_NAMING_DELAY_MS", "700");
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  vi.spyOn(console, "warn").mockImplementation((...args) => {
    if (args.join(" ").includes("renamed while its title was generated")) finish();
  });
  const { project } = await addProject(server);
  const api = await server.rpc();
  const updates = await api.tasks.watch();
  const next = async (): Promise<Task[]> =>
    Task.array().parse((await within(updates.next(), "a tasks update")).value);
  try {
    expect(await next()).toEqual([]);
    const task = await api.tasks.create({
      projectId: project.id,
      prompt: "Make the login retry",
      workspace: { type: "main-worktree" },
    });
    expect(await next()).toEqual([task]);

    const renamed = await api.tasks.rename({ id: task.id, title: "My own name" });
    expect(await next()).toEqual([renamed]);

    // The naming run finished and declined to overwrite the user's title.
    await within(finished, "the naming run to finish");
    const list = await api.tasks.watch();
    try {
      expect((await within(list.next(), "the final task list")).value).toEqual([renamed]);
    } finally {
      await list.return?.();
    }
  } finally {
    await updates.return?.();
  }
});

test("an explicit or issue title never starts a naming run", async () => {
  await configure(PROFILE);
  const { project } = await addProject(server);
  const api = await server.rpc();

  await api.tasks.create({
    projectId: project.id,
    title: "Typed by hand",
    prompt: "Something the agent should do",
    workspace: { type: "main-worktree" },
  });
  await api.tasks.create({
    projectId: project.id,
    source: {
      provider: "github",
      host: "github.com",
      repository: "acme/app",
      number: 9,
      url: "https://github.com/acme/app/issues/9",
      title: "Issue wording",
      body: "",
      fetchedAt: 1,
    },
    prompt: "Something the agent should do",
    workspace: { type: "main-worktree" },
  });

  expect(await fake.runs()).toEqual([]);
});

test("an empty [naming] keeps the seed and runs nothing", async () => {
  const { project } = await addProject(server);
  const api = await server.rpc();

  const task = await api.tasks.create({
    projectId: project.id,
    prompt: "Only a prompt",
    workspace: { type: "main-worktree" },
  });

  expect(task).toMatchObject({ title: "Only a prompt", titleSource: "seed" });
  expect(await fake.runs()).toEqual([]);
});
