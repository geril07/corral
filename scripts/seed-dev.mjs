#!/usr/bin/env node
// Fills a running dev stack with the data an audit needs: a repository with uncommitted changes, a
// project, a task with a chat transcript, a task with a shell, and a settled task. Run
// `pnpm dev --fake-agents` first: the chat task needs an agent that answers without a login and
// without a paid model call, and the fake CLIs are only on the server's PATH when it was started
// that way. Data lands in `.dev/`, so the installed app and the user's own config are untouched.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCorralClient } from "../packages/client/src/corral-client.ts";

const repository = join(import.meta.dirname, "..");
const stateDir = process.env["CORRAL_STATE_DIR"] ?? join(repository, ".dev", "state");
const fixtures = join(repository, ".dev", "fixtures", "repos");

function git(cwd, args) {
  return execFileSync(
    "git",
    ["-c", "user.name=Corral Seed", "-c", "user.email=seed@corral.invalid", ...args],
    { cwd, encoding: "utf8" },
  );
}

/** A repository whose working tree already has a modification and an untracked file. */
function fixtureRepo(name) {
  const path = join(fixtures, name);
  // Rebuilt every run, so a half-seeded fixture cannot be photographed as if it were real.
  rmSync(path, { recursive: true, force: true });
  mkdirSync(join(path, "src"), { recursive: true });
  git(path, ["init", "-q", "-b", "main"]);
  writeFileSync(join(path, "README.md"), `# ${name}\n\nFixture repository for UI review.\n`);
  writeFileSync(
    join(path, "src", "upload.ts"),
    "export async function upload(file: File): Promise<void> {\n  await fetch('/api/upload', { method: 'POST', body: file });\n}\n",
  );
  writeFileSync(join(path, "package.json"), '{"name":"' + name + '","private":true}\n');
  git(path, ["add", "-A"]);
  git(path, ["commit", "-q", "-m", "feat: upload files"]);
  writeFileSync(
    join(path, "src", "upload.ts"),
    "const RETRIES = 3;\n\nexport async function upload(file: File): Promise<void> {\n  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {\n    const response = await fetch('/api/upload', { method: 'POST', body: file });\n    if (response.ok) return;\n  }\n  throw new Error('upload failed');\n}\n",
  );
  writeFileSync(
    join(path, "src", "retry.ts"),
    "export const backoff = (attempt: number) => 2 ** attempt;\n",
  );
  return path;
}

const endpoint = JSON.parse(readFileSync(join(stateDir, "endpoint.json"), "utf8"));
const client = createCorralClient({
  server: { url: endpoint.url, capability: endpoint.capability },
});
const api = client.connection.api;
const size = { cols: 100, rows: 30 };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const connection = client.connection.state;
const connected = await new Promise((resolve) => {
  if (connection.getSnapshot().status === "connected") return resolve(true);
  const deadline = setTimeout(() => resolve(false), 10_000);
  const stop = connection.subscribe(() => {
    if (connection.getSnapshot().status !== "connected") return;
    clearTimeout(deadline);
    stop();
    resolve(true);
  });
});
if (!connected) {
  throw new Error(
    `the dev server at ${endpoint.url} did not accept the connection; is \`pnpm dev\` running?`,
  );
}

try {
  const project = await api.projects.add({ path: fixtureRepo("orbit") }).catch((error) => {
    if (String(error?.message ?? error).includes("already added")) {
      throw new Error(
        "this .dev/ is already seeded; run `rm -rf .dev`, then `pnpm dev --fake-agents` and `pnpm seed` again",
      );
    }
    throw error;
  });
  const workspace = { type: "main-worktree" };

  const chat = await api.tasks.create({
    projectId: project.id,
    title: "Retry the upload job",
    prompt: "Add retries to the upload job and keep the existing backoff.",
    agent: { kind: "pi", view: "chat" },
    workspace,
  });
  // The fake agent streams a short turn for the prompt; give it a moment before the audit opens the page.
  await sleep(3000);

  const shell = await api.tasks.create({
    projectId: project.id,
    title: "Inspect the build",
    workspace,
  });
  await api.sessions.start({ taskId: shell.id, kind: "shell", size });

  const done = await api.tasks.create({
    projectId: project.id,
    title: "Update the old upload modal",
    workspace,
  });
  await api.tasks.setState({ id: done.id, state: "settled" });

  console.log(
    `corral seed: project ${project.id}, tasks ${chat.id} (chat), ${shell.id} (shell), ${done.id} (settled)`,
  );
  console.log(`corral seed: fixture repository at ${join(fixtures, "orbit")}`);
} finally {
  client.close();
}
