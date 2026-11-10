import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { cloneOfOrigin, commitFile, initRepo, runGit } from "../../test/git-repo.ts";
import { addProject } from "../../test/project-fixture.ts";
import { useServer, within } from "../../test/server-fixture.ts";

const server = useServer();

test("directory completion reads server home and navigable folders, not files or hidden siblings", async () => {
  for (const name of ["alpha", "alpine", "space Юникод", ".hidden"])
    mkdirSync(join(server.homeDir, name));
  writeFileSync(join(server.homeDir, "afile"), "file");
  symlinkSync(join(server.homeDir, "alpha"), join(server.homeDir, "alias"), "dir");
  const api = await server.rpc();
  const home = await api.projects.directories({ path: "~/" });
  expect(home.directories.map((entry) => entry.name)).toEqual([
    "alias",
    "alpha",
    "alpine",
    "space Юникод",
  ]);
  expect(home.truncated).toBe(false);
  expect(
    (await api.projects.directories({ path: "~/al" })).directories.map((entry) => entry.name),
  ).toEqual(["alias", "alpha", "alpine"]);
  expect(
    (await api.projects.directories({ path: "~/." })).directories.map((entry) => entry.name),
  ).toEqual([".hidden"]);
  expect(await api.projects.directories({ path: "~/alias/" })).toEqual({
    directories: [],
    truncated: false,
  });
  await expect(api.projects.directories({ path: "~/missing/" })).rejects.toMatchObject({
    code: "DIRECTORY_UNREADABLE",
  });
  await expect(api.projects.directories({ path: "relative/" })).rejects.toMatchObject({
    code: "DIRECTORY_UNREADABLE",
  });
  expect((await api.projects.watch().then((updates) => updates.next())).value).toEqual([]);
});

test("directory listing honestly marks its response limit and can narrow the prefix", async () => {
  for (let index = 0; index < 205; index++)
    mkdirSync(join(server.homeDir, `folder-${String(index).padStart(3, "0")}`));
  const api = await server.rpc();
  const result = await api.projects.directories({ path: "~/" });
  expect(result.directories).toHaveLength(200);
  expect(result.truncated).toBe(true);
  const narrowed = await api.projects.directories({ path: "~/folder-204" });
  expect(narrowed.directories.map((entry) => entry.name)).toEqual(["folder-204"]);
  expect(narrowed.truncated).toBe(false);
});

test.skipIf(process.getuid?.() === 0)(
  "directory errors are not empty successes and permissions can be retried (requires non-root)",
  async () => {
    const denied = join(server.homeDir, "denied");
    mkdirSync(denied);
    chmodSync(denied, 0);
    const api = await server.rpc();
    try {
      await expect(api.projects.directories({ path: `${denied}/` })).rejects.toMatchObject({
        code: "DIRECTORY_UNREADABLE",
        data: { message: "Permission denied reading this server directory." },
      });
    } finally {
      chmodSync(denied, 0o700);
    }
    expect(await api.projects.directories({ path: `${denied}/` })).toEqual({
      directories: [],
      truncated: false,
    });
  },
);

test("completion preserves long names and server case semantics", async () => {
  const long = `Long ${"x".repeat(220)} Ю`;
  mkdirSync(join(server.homeDir, long));
  const api = await server.rpc();
  expect((await api.projects.directories({ path: "~/Long" })).directories).toEqual([
    { name: long, path: `${join(server.homeDir, long)}/` },
  ]);
});

test.skipIf(process.platform !== "linux")(
  "Linux directory prefixes are case sensitive",
  async () => {
    mkdirSync(join(server.homeDir, "Upper"));
    const api = await server.rpc();
    expect((await api.projects.directories({ path: "~/upper" })).directories).toEqual([]);
  },
);

test("add registers the repository, named after its directory", async () => {
  const repo = initRepo(join(server.scratchDir, "my-app"));
  const api = await server.rpc();

  const project = await api.projects.add({ path: repo });

  expect(project).toEqual({
    id: expect.stringMatching(/^[0-9a-f]{12}$/),
    name: "my-app",
    path: repo,
    defaultBaseBranch: "main",
    pinnedAt: null,
  });
  expect(await api.projects.watch().then((updates) => updates.next())).toMatchObject({
    value: [project],
  });
});

test("add expands ~ with the server's home, trims the input and stores git's absolute path", async () => {
  const repo = initRepo(join(server.homeDir, "code", "my", "corral"));
  const api = await server.rpc();

  const project = await api.projects.add({ path: "  ~/code/my/corral/  " });

  expect(project).toMatchObject({ name: "corral", path: repo, defaultBaseBranch: "main" });

  // Trimmed to nothing, whitespace is still a refusal: an empty input must not become the cwd.
  for (const path of [" ", "\t\n"]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one case at a time keeps failures readable
    await expect(api.projects.add({ path })).rejects.toMatchObject({
      code: "GIT_FAILED",
      data: { message: "the project path must be an absolute path or start with ~/" },
    });
  }
});

test("~ and ~/ resolve to the server's home", async () => {
  const home = initRepo(server.homeDir);
  const api = await server.rpc();

  const project = await api.projects.add({ path: " ~ " });
  expect(project.path).toBe(home);
  await api.projects.remove({ id: project.id });

  expect((await api.projects.add({ path: "~/" })).path).toBe(home);
});

test("a home that is not a repository gets the true not-a-repository sentence", async () => {
  const api = await server.rpc();

  for (const path of ["~", "~/"]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one case at a time keeps failures readable
    await expect(api.projects.add({ path })).rejects.toMatchObject({
      code: "NOT_A_GIT_REPOSITORY",
      data: { path: server.homeDir },
    });
  }
});

test("add of a missing directory, a file or a relative path names its real cause", async () => {
  const missing = join(server.scratchDir, "missing");
  const file = join(server.scratchDir, "file");
  writeFileSync(file, "not a directory\n");
  const api = await server.rpc();

  await expect(api.projects.add({ path: missing })).rejects.toMatchObject({
    code: "GIT_FAILED",
    data: { message: `no such directory: ${missing}` },
  });
  await expect(api.projects.add({ path: ` ${file} ` })).rejects.toMatchObject({
    code: "GIT_FAILED",
    data: { message: `not a directory: ${file}` },
  });
  for (const path of ["relative/repo", "~foo", "~user/repo"]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one case at a time keeps failures readable
    await expect(api.projects.add({ path })).rejects.toMatchObject({
      code: "GIT_FAILED",
      data: { message: "the project path must be an absolute path or start with ~/" },
    });
  }
  await expect(api.projects.add({ path: "~/missing" })).rejects.toMatchObject({
    code: "GIT_FAILED",
    data: { message: `no such directory: ${join(server.homeDir, "missing")}` },
  });
});

test.runIf(process.platform !== "win32")(
  "a symlink loop names the loop instead of becoming an internal error",
  async () => {
    const loop = join(server.scratchDir, "loop");
    symlinkSync(loop, loop);
    const api = await server.rpc();

    await expect(api.projects.add({ path: loop })).rejects.toMatchObject({
      code: "GIT_FAILED",
      data: { message: `too many levels of symbolic links: ${loop}` },
    });
  },
);

test.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
  "a directory the server cannot search names the permission refusal",
  async () => {
    const locked = join(server.scratchDir, "locked");
    const child = join(locked, "child");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    const api = await server.rpc();

    try {
      await expect(api.projects.add({ path: child })).rejects.toMatchObject({
        code: "GIT_FAILED",
        data: { message: `permission denied: ${child}` },
      });
    } finally {
      // The fixture must be able to delete the scratch directory afterwards.
      chmodSync(locked, 0o700);
    }
  },
);

test("a repository added through ~ is a duplicate of its absolute path", async () => {
  const repo = initRepo(join(server.homeDir, "app"));
  const api = await server.rpc();
  const project = await api.projects.add({ path: "~/app" });

  await expect(api.projects.add({ path: repo })).rejects.toMatchObject({
    code: "PROJECT_EXISTS",
    data: { id: project.id },
  });
});

test("add of a repository with no branch to start tasks from fails with GIT_FAILED", async () => {
  const repo = initRepo(join(server.scratchDir, "app"));
  runGit(repo, "checkout", "-q", "--detach");
  runGit(repo, "branch", "-q", "-D", "main");
  const api = await server.rpc();

  await expect(api.projects.add({ path: repo })).rejects.toMatchObject({
    code: "GIT_FAILED",
    data: { message: expect.stringContaining("no branch") },
  });
});

test("add from a subdirectory registers the repository root", async () => {
  const repo = initRepo(join(server.scratchDir, "app"));
  mkdirSync(join(repo, "src", "deep"), { recursive: true });
  const api = await server.rpc();

  const project = await api.projects.add({ path: join(repo, "src", "deep") });

  expect(project.path).toBe(repo);
});

test("add from a linked worktree registers the main working tree", async () => {
  const repo = initRepo(join(server.scratchDir, "app"));
  const linked = join(server.scratchDir, "linked");
  runGit(repo, "worktree", "add", "-b", "other", linked);
  const api = await server.rpc();

  const project = await api.projects.add({ path: linked });

  expect(project).toMatchObject({ name: "app", path: repo, defaultBaseBranch: "main" });
});

test("a plain directory outside a repository fails with NOT_A_GIT_REPOSITORY", async () => {
  const plain = join(server.scratchDir, "plain");
  mkdirSync(plain);
  const api = await server.rpc();

  await expect(api.projects.add({ path: plain })).rejects.toMatchObject({
    code: "NOT_A_GIT_REPOSITORY",
    data: { path: plain },
  });
  expect(await api.projects.watch().then((updates) => updates.next())).toMatchObject({ value: [] });
});

test("a bare repository keeps git's work-tree refusal instead of claiming it is not a repository", async () => {
  const { origin } = cloneOfOrigin(join(server.scratchDir));
  const api = await server.rpc();

  await expect(api.projects.add({ path: origin })).rejects.toMatchObject({
    code: "GIT_FAILED",
    data: { message: expect.stringContaining("must be run in a work tree") },
  });
});

test("adding the same repository again fails with PROJECT_EXISTS, also through a subdirectory or a linked worktree", async () => {
  const repo = initRepo(join(server.scratchDir, "app"));
  mkdirSync(join(repo, "src"));
  const linked = join(server.scratchDir, "linked");
  runGit(repo, "worktree", "add", "-b", "other", linked);
  const api = await server.rpc();
  const project = await api.projects.add({ path: repo });

  for (const path of [repo, join(repo, "src"), linked]) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one case at a time keeps failures readable
    await expect(api.projects.add({ path })).rejects.toMatchObject({
      code: "PROJECT_EXISTS",
      data: { id: project.id },
    });
  }
});

test("adding a repository through a symlink registers its real path once", async () => {
  const repo = initRepo(join(server.scratchDir, "app"));
  const link = join(server.scratchDir, "link");
  symlinkSync(repo, link);
  const api = await server.rpc();

  expect((await api.projects.add({ path: link })).path).toBe(repo);
});

test("the default base branch is origin/HEAD's branch, whatever is checked out", async () => {
  const { clone } = cloneOfOrigin(server.scratchDir);
  runGit(clone, "switch", "-c", "scratch");
  const api = await server.rpc();

  expect((await api.projects.add({ path: clone })).defaultBaseBranch).toBe("trunk");
});

test("without origin/HEAD the default base branch is the checked-out branch", async () => {
  const { clone } = cloneOfOrigin(server.scratchDir);
  runGit(clone, "remote", "set-head", "origin", "--delete");
  runGit(clone, "switch", "-c", "scratch");
  const plain = initRepo(join(server.scratchDir, "plain"), "develop");
  const api = await server.rpc();

  expect((await api.projects.add({ path: clone })).defaultBaseBranch).toBe("scratch");
  expect((await api.projects.add({ path: plain })).defaultBaseBranch).toBe("develop");
});

test("branches offers only targets a worktree can check out, from the main tree and every linked one", async () => {
  const { clone } = cloneOfOrigin(server.scratchDir);
  runGit(clone, "branch", "free");
  runGit(clone, "branch", "feature/login");
  const linked = join(server.scratchDir, "linked");
  runGit(clone, "worktree", "add", "--", linked, "feature/login");
  // A local branch checked out in a linked worktree hides it and its remote-tracking ref.
  runGit(clone, "branch", "release/1.0", "--no-track", "origin/trunk");
  const heldRemote = join(server.scratchDir, "held-remote");
  runGit(clone, "worktree", "add", "--", heldRemote, "release/1.0");
  // A remote-tracking ref whose local branch is free stays offered.
  runGit(clone, "push", "origin", "trunk:keep");
  // Remote refs whose derived local names conflict with a local namespace stay hidden:
  // `origin/feature` would need local `feature`, which `feature/login` blocks; the same for
  // `origin/blocked/x` under the free local `blocked`.
  runGit(clone, "branch", "blocked");
  runGit(clone, "push", "origin", "feature/login:feature", "trunk:blocked/x");
  runGit(clone, "fetch", "origin");
  const api = await server.rpc();
  const project = await api.projects.add({ path: clone });

  // `trunk` is held by the main tree, `feature/login` and `release/1.0` by linked worktrees.
  expect(await api.projects.branches({ id: project.id })).toEqual([
    "blocked",
    "free",
    "origin/keep",
  ]);
});

test.runIf(process.platform !== "win32")(
  "a worktree path with a newline is one holding path, not a false branch line",
  async () => {
    const repo = initRepo(join(server.scratchDir, "app"));
    runGit(repo, "branch", "held");
    runGit(repo, "branch", "injected");
    const linked = join(server.scratchDir, "held\nbranch refs/heads/injected");
    runGit(repo, "worktree", "add", "--", linked, "held");
    const api = await server.rpc();
    const project = await api.projects.add({ path: repo });

    // Splitting the listing on newlines would read the path's second line as `injected`'s
    // holding branch and hide it; the real holder is `held`.
    expect(await api.projects.branches({ id: project.id })).toEqual(["injected"]);
  },
);

test("baseRefs offers local branches a worktree holds and remote-tracking refs", async () => {
  const { clone } = cloneOfOrigin(server.scratchDir);
  runGit(clone, "branch", "feature/login");
  const linked = join(server.scratchDir, "base-ref-linked");
  runGit(clone, "worktree", "add", "--", linked, "feature/login");
  const api = await server.rpc();
  const project = await api.projects.add({ path: clone });

  // The base question, not `branches`' checkout one: `trunk` and `feature/login` are held by a
  // worktree yet both are valid bases, and every remote-tracking ref is one too. The groups stay
  // separate: `trunk` and `origin/trunk` are different starting points.
  expect(await api.projects.baseRefs({ id: project.id })).toEqual({
    local: ["feature/login", "trunk"],
    remote: ["origin/release/1.0", "origin/trunk"],
    currentBranch: "trunk",
  });
  expect(await api.projects.branches({ id: project.id })).toEqual(["origin/release/1.0"]);
});

test("baseRefs names the main tree's checkout, not the base stored when the project was added", async () => {
  const { clone } = cloneOfOrigin(server.scratchDir);
  const api = await server.rpc();
  const project = await api.projects.add({ path: clone });
  runGit(clone, "switch", "-c", "scratch");

  expect(project.defaultBaseBranch).toBe("trunk");
  expect(await api.projects.baseRefs({ id: project.id })).toMatchObject({
    currentBranch: "scratch",
  });
  runGit(clone, "checkout", "--detach");
  expect(await api.projects.baseRefs({ id: project.id })).toMatchObject({ currentBranch: null });
});

test("a task can start from a branch another worktree holds", async () => {
  const { project, repo } = await addProject(server);
  runGit(repo, "switch", "-c", "feature/held");
  commitFile(repo, "held.txt", "held\n");
  runGit(repo, "switch", "main");
  const linked = join(server.scratchDir, "held-base");
  runGit(repo, "worktree", "add", "--", linked, "feature/held");
  const api = await server.rpc();

  expect((await api.projects.baseRefs({ id: project.id })).local).toContain("feature/held");
  const task = await api.tasks.create({
    projectId: project.id,
    title: "From a held base",
    workspace: { type: "new-branch", baseBranch: "feature/held" },
  });

  expect(runGit(task.workspacePath, "rev-parse", "HEAD")).toBe(runGit(linked, "rev-parse", "HEAD"));
  expect(runGit(task.workspacePath, "log", "-1", "--format=%s").trim()).toBe("held.txt");
});

test("branches fails with typed errors for an unknown project and for a repository that is gone", async () => {
  const repo = initRepo(join(server.scratchDir, "app"));
  const api = await server.rpc();
  const project = await api.projects.add({ path: repo });

  await expect(api.projects.branches({ id: "nope" })).rejects.toMatchObject({
    code: "PROJECT_NOT_FOUND",
    data: { id: "nope" },
  });
  await rm(repo, { recursive: true });
  await expect(api.projects.branches({ id: project.id })).rejects.toMatchObject({
    code: "GIT_FAILED",
  });
});

test("remove forgets the project, leaves the repository alone and tells watchers", async () => {
  const repo = initRepo(join(server.scratchDir, "app"));
  const api = await server.rpc();
  const updates = await api.projects.watch();
  const next = async () => (await within(updates.next(), "a projects update")).value;
  expect(await next()).toEqual([]);
  const project = await api.projects.add({ path: repo });
  expect(await next()).toEqual([project]);

  await api.projects.remove({ id: project.id });

  expect(await next()).toEqual([]);
  expect(runGit(repo, "log", "--oneline")).toContain("initial commit");
  await expect(api.projects.remove({ id: project.id })).rejects.toMatchObject({
    code: "PROJECT_NOT_FOUND",
  });
  await updates.return?.();
});

test("pin and unpin roundtrip through the RPC and reach watchers", async () => {
  const repo = initRepo(join(server.scratchDir, "app"));
  const api = await server.rpc();
  const updates = await api.projects.watch();
  const next = async () => (await within(updates.next(), "a projects update")).value;
  expect(await next()).toEqual([]);
  const project = await api.projects.add({ path: repo });
  expect(await next()).toEqual([project]);

  const before = Date.now();
  const pinned = await api.projects.setPinned({ id: project.id, pinned: true });
  expect(pinned.pinnedAt).toBeGreaterThanOrEqual(before);
  expect(await next()).toEqual([pinned]);

  const unpinned = await api.projects.setPinned({ id: project.id, pinned: false });
  expect(unpinned.pinnedAt).toBeNull();
  expect(await next()).toEqual([unpinned]);

  await expect(api.projects.setPinned({ id: "nope", pinned: true })).rejects.toMatchObject({
    code: "PROJECT_NOT_FOUND",
    data: { id: "nope" },
  });
  await updates.return?.();
});

test("a pin is stored and survives reopening the database", async () => {
  const repo = initRepo(join(server.scratchDir, "app"));
  const api = await server.rpc();
  const project = await api.projects.add({ path: repo });
  const pinned = await api.projects.setPinned({ id: project.id, pinned: true });

  await server.restart();

  const restarted = await server.rpc();
  expect((await restarted.projects.watch().then((updates) => updates.next())).value).toEqual([
    pinned,
  ]);
});

test("a pin goes away with its project", async () => {
  const repo = initRepo(join(server.scratchDir, "app"));
  const api = await server.rpc();
  const project = await api.projects.add({ path: repo });
  await api.projects.setPinned({ id: project.id, pinned: true });

  await api.projects.remove({ id: project.id });

  expect(await api.projects.watch().then((updates) => updates.next())).toMatchObject({ value: [] });
  expect((await api.projects.add({ path: repo })).pinnedAt).toBeNull();
});

test("projects survive a server restart on the same data directory", async () => {
  const repo = initRepo(join(server.scratchDir, "app"));
  const project = await (await server.rpc()).projects.add({ path: repo });

  await server.restart();

  const api = await server.rpc();
  expect((await api.projects.watch().then((updates) => updates.next())).value).toEqual([project]);
  await expect(api.projects.add({ path: repo })).rejects.toMatchObject({ code: "PROJECT_EXISTS" });
});
