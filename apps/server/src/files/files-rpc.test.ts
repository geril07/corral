import { ConfigState } from "@corral/protocol/config";
import { FILE_PREVIEW_LIMITS, type FileResolution } from "@corral/protocol/rpc";
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { addTask } from "../../test/project-fixture.ts";
import { useServer, within } from "../../test/server-fixture.ts";

const server = useServer();
const SIZE = { cols: 80, rows: 24 };

// The editor precedence is `[editor] command`, `$VISUAL`, `$EDITOR`: clear the developer's own
// variables so a machine with `VISUAL=nvim` runs the same test as one without.
beforeEach(() => {
  vi.stubEnv("VISUAL", "");
  vi.stubEnv("EDITOR", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

/** A task whose workspace is the repository itself, with the files a chat message would name. */
async function localTask() {
  const { api, repo, task } = await addTask(server, "Local links", "main-worktree");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "app.ts"), "const answer = 42;\n");
  writeFileSync(join(repo, "shot.png"), PNG);
  writeFileSync(join(repo, "clip.mp4"), Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
  return { api, repo, task };
}

type Api = Awaited<ReturnType<typeof localTask>>["api"];

/** Writes `config.toml` and waits until the server has read it. */
async function configure(api: Api, text: string): Promise<ConfigState> {
  const updates = await api.config.watch();
  await updates.next();
  await mkdir(server.configDir, { recursive: true });
  await writeFile(join(server.configDir, "config.toml"), text);
  return ConfigState.parse((await within(updates.next(), "the config change")).value);
}

/** An editor that records the argv it was run with, so a launch is observable from disk. */
function fakeEditor(name = "fake-editor"): { path: string; log: string } {
  const path = join(server.scratchDir, name);
  const log = join(server.scratchDir, `${name}.log`);
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`);
  chmodSync(path, 0o755);
  return { path, log };
}

/** What each candidate became: its path when it resolved, its status otherwise. */
const results = (resolutions: readonly FileResolution[]) =>
  resolutions.map((resolution) =>
    resolution.status === "ok" ? resolution.target.path : resolution,
  );

test("resolve answers a target, a miss and a refusal per candidate", async () => {
  const { api, repo, task } = await localTask();
  const outside = join(server.scratchDir, "secret.txt");
  writeFileSync(outside, "secret\n");
  symlinkSync(outside, join(repo, "escape.txt"));

  const { results: resolved } = await api.files.resolve({
    taskId: task.id,
    paths: ["src/app.ts", "src/missing.ts", "../outside.txt", outside, "escape.txt", "src"],
  });

  expect(results(resolved)).toEqual([
    "src/app.ts",
    { status: "missing", requested: "src/missing.ts" },
    { status: "outside", requested: "../outside.txt" },
    { status: "outside", requested: outside },
    { status: "outside", requested: "escape.txt" },
    "src",
  ]);
  expect(resolved[0]).toMatchObject({
    status: "ok",
    target: { requested: "src/app.ts", path: "src/app.ts", name: "app.ts", kind: "file" },
  });
  expect(resolved[5]).toMatchObject({ status: "ok", target: { kind: "directory" } });
});

test("resolve marks what one message can preview inline", async () => {
  const { api, task } = await localTask();
  const { results: resolved } = await api.files.resolve({
    taskId: task.id,
    paths: ["shot.png", "clip.mp4", "src/app.ts"],
  });
  expect(resolved).toMatchObject([
    { status: "ok", target: { media: "image", mime: "image/png", previewable: true } },
    { status: "ok", target: { media: "video", mime: "video/mp4", previewable: true } },
    { status: "ok", target: { media: null, mime: null, previewable: false } },
  ]);
});

test("read serves an image's bytes over the authenticated channel, base64", async () => {
  const { api, task } = await localTask();
  const bytes = await api.files.read({ taskId: task.id, path: "shot.png" });

  expect(bytes).toMatchObject({ path: "shot.png", media: "image", mime: "image/png" });
  expect(Buffer.from(bytes.bytes, "base64")).toEqual(PNG);
});

test("read refuses a path outside the workspace with the typed error, not a 404", async () => {
  const { api, task } = await localTask();
  await expect(api.files.read({ taskId: task.id, path: "/etc/hostname" })).rejects.toMatchObject({
    code: "FILE_OUTSIDE_WORKSPACE",
    data: { path: "/etc/hostname" },
  });
  await expect(
    api.files.read({ taskId: task.id, path: "../../etc/hostname" }),
  ).rejects.toMatchObject({ code: "FILE_OUTSIDE_WORKSPACE" });
});

test("read refuses a directory, a non-previewable type and an oversized file", async () => {
  const { api, repo, task } = await localTask();
  await expect(api.files.read({ taskId: task.id, path: "src" })).rejects.toMatchObject({
    code: "FILE_IS_DIRECTORY",
  });
  await expect(api.files.read({ taskId: task.id, path: "src/app.ts" })).rejects.toMatchObject({
    code: "FILE_TYPE_UNSUPPORTED",
  });

  // One byte past the image bound: resolvable, but never served, and no broken frame either.
  const big = Buffer.alloc(FILE_PREVIEW_LIMITS.image + 1);
  writeFileSync(join(repo, "big.png"), big);
  await expect(api.files.read({ taskId: task.id, path: "big.png" })).rejects.toMatchObject({
    code: "FILE_TOO_LARGE",
    data: {
      path: "big.png",
      size: FILE_PREVIEW_LIMITS.image + 1,
      limit: FILE_PREVIEW_LIMITS.image,
    },
  });
  const { results: resolved } = await api.files.resolve({ taskId: task.id, paths: ["big.png"] });
  expect(resolved[0]).toMatchObject({ status: "ok", target: { previewable: false } });
});

test("openEditor runs a resolved file through [editor] command and reports its terminal", async () => {
  const { api, repo, task } = await localTask();
  const editor = fakeEditor();
  await configure(api, `[editor]\ncommand = "${editor.path} {file}:{line}"\n`);

  const opened = await api.files.openEditor({
    taskId: task.id,
    path: "src/app.ts",
    line: 12,
    size: SIZE,
  });

  const terminal = (await api.terminals.list()).find((each) => each.id === opened.terminalId);
  expect(terminal).toMatchObject({
    command: editor.path,
    args: [`${join(repo, "src", "app.ts")}:12`],
    cwd: repo,
    // Loose: the editor belongs to no session, so a task's terminals keep one owner (`design.md`).
    taskId: null,
    sessionId: null,
  });
  // The process really ran with that argv, not just a record of it.
  await vi.waitFor(() =>
    expect(readFileSync(editor.log, "utf8").trim()).toBe(`${join(repo, "src", "app.ts")}:12`),
  );
});

test("openEditor falls back to $EDITOR, and a path outside the workspace is refused", async () => {
  const { api, repo, task } = await localTask();
  const editor = fakeEditor();
  vi.stubEnv("EDITOR", editor.path);

  const opened = await api.files.openEditor({ taskId: task.id, path: "shot.png", size: SIZE });
  const terminal = (await api.terminals.list()).find((each) => each.id === opened.terminalId);
  expect(terminal).toMatchObject({ command: editor.path, cwd: repo });

  await expect(
    api.files.openEditor({ taskId: task.id, path: "../outside.txt", size: SIZE }),
  ).rejects.toMatchObject({ code: "FILE_OUTSIDE_WORKSPACE" });
});

test("openEditor refuses with a reason when nothing is configured or the editor is missing", async () => {
  const { api, task } = await localTask();
  await expect(
    api.files.openEditor({ taskId: task.id, path: "src/app.ts", size: SIZE }),
  ).rejects.toMatchObject({
    code: "EDITOR_UNSET",
    data: { reason: expect.stringContaining("[editor] command") },
  });

  await configure(api, `[editor]\ncommand = "${join(server.scratchDir, "no-such-editor")}"\n`);
  await expect(
    api.files.openEditor({ taskId: task.id, path: "src/app.ts", size: SIZE }),
  ).rejects.toMatchObject({ code: "EDITOR_NOT_FOUND" });
});

test("an invalid [editor] command drops only itself and is reported", async () => {
  const { api, task } = await localTask();
  const state = await configure(
    api,
    `[editor]\ncommand = "code \\"unterminated"\n\n[tasks]\nbranch-prefix = "work/"\n`,
  );

  expect(state.problems).toMatchObject([
    { severity: "error", path: "editor.command", message: expect.stringContaining("unterminated") },
  ]);
  // The rest of the file still applies, and nothing is configured for the editor.
  expect(state.config.tasks.branchPrefix.value).toBe("work/");
  expect(state.config.editor.command).toEqual({ value: "", source: "default" });
  expect(await api.files.resolve({ taskId: task.id, paths: [] })).toEqual({ results: [] });
});
