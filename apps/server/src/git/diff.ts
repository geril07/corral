import { lstat, open, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { ChangeDiff, ChangeFile, ChangeStatus, ChangesBase } from "@corral/protocol/rpc";
import { gitRead } from "./git.ts";

/**
 * The most changed files one task's read model lists. Past this a repository's diff is not a tab
 * anyone reads, and the event would grow with the repository instead of the task.
 */
export const MAX_CHANGED_FILES = 500;

/** The most characters one file's patch carries; a longer diff is cut at a hunk or line boundary. */
export const MAX_DIFF_CHARACTERS = 512 * 1024;

/**
 * The most of an untracked file the server reads to count and diff it: enough for any file a
 * person reviews, bounded so one large file cannot exhaust the server's memory. A file longer than
 * this is listed with `partial` counts from that prefix, never as a complete count.
 */
export const MAX_UNTRACKED_BYTES = 8 * 1024 * 1024;

/** Git's own binary heuristic: a NUL byte in the first 8 kB. */
const BINARY_SNIFF_BYTES = 8000;

/** One entry of `git diff --name-status -z`. */
export interface ChangedName {
  status: ChangeStatus;
  path: string;
  oldPath: string | null;
}

/** One entry of `git diff --numstat -z`. */
export interface LineCounts {
  additions: number;
  deletions: number;
  binary: boolean;
}

/**
 * `git diff --name-status -z` output. Entries are NUL separated: `M\0path\0`, and for a rename or
 * copy `R100\0old\0new\0`, where the score after the letter is dropped. A copy is listed as an
 * addition because `layout.md` has four status letters and a copy adds a file.
 */
export function parseNameStatus(output: string): ChangedName[] {
  const entries = output.split("\0");
  const names: ChangedName[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined || entry === "") continue;
    const letter = entry.charAt(0);
    if (letter === "R" || letter === "C") {
      const oldPath = entries[i + 1];
      const path = entries[i + 2];
      i += 2;
      if (path === undefined) break;
      names.push(
        letter === "C"
          ? { status: "A", path, oldPath: null }
          : { status: "R", path, oldPath: oldPath ?? null },
      );
      continue;
    }
    const path = entries[i + 1];
    i += 1;
    if (path === undefined) break;
    names.push({ status: statusOf(letter), path, oldPath: null });
  }
  return names;
}

/** A status letter git can print that `layout.md` has no letter of its own for (a type change). */
function statusOf(letter: string): ChangeStatus {
  if (letter === "A") return "A";
  if (letter === "D") return "D";
  return "M";
}

/**
 * `git diff --numstat -z` output, keyed by the path after the change. With `-z` the path is raw,
 * so one may hold tabs: only the first two fields are numbers, and the rest is the path. A rename's
 * two paths follow the empty path field as their own entries; a binary file's counts are `-`/`-`.
 */
export function parseNumstat(output: string): Map<string, LineCounts> {
  const entries = output.split("\0");
  const counts = new Map<string, LineCounts>();
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined || entry === "") continue;
    const fields = entry.split("\t");
    const added = fields[0] ?? "";
    const deleted = fields[1] ?? "";
    let path = fields.slice(2).join("\t");
    if (path === "") {
      // A rename or copy: the old path and the new one are the next two entries.
      i += 2;
      path = entries[i] ?? "";
    }
    if (path === "") continue;
    const binary = added === "-" || deleted === "-";
    counts.set(path, {
      additions: binary ? 0 : Number.parseInt(added, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(deleted, 10) || 0,
      binary,
    });
  }
  return counts;
}

/** The two git outputs as one file list, sorted by path; a file without counts gets zeros. */
export function mergeChangedFiles(
  names: readonly ChangedName[],
  counts: ReadonlyMap<string, LineCounts>,
): ChangeFile[] {
  return names
    .map((name) => {
      const lines = counts.get(name.path);
      return {
        path: name.path,
        oldPath: name.oldPath,
        status: name.status,
        additions: lines?.additions ?? 0,
        deletions: lines?.deletions ?? 0,
        binary: lines?.binary ?? false,
        partial: false,
        note: null,
      };
    })
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Whether a file's start looks binary by git's rule. */
export function looksBinary(bytes: Uint8Array): boolean {
  const sniffed = bytes.subarray(0, BINARY_SNIFF_BYTES);
  return sniffed.includes(0);
}

/** The number of lines a patch would add for these bytes; a trailing newline opens no empty line. */
export function countLines(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let newlines = 0;
  for (const byte of bytes) if (byte === 10) newlines += 1;
  return bytes[bytes.length - 1] === 10 ? newlines : newlines + 1;
}

/** A text's lines as a patch adds them: the trailing newline does not open an empty line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Git's C-style quoting for a path in a patch header, so a tab or a quote cannot break the header. */
export function quotePatchPath(path: string): string {
  // oxlint-disable-next-line no-control-regex -- the control characters ARE what is quoted
  if (!/[\t\n\r"\\\u0000-\u001f]/.test(path)) return path;
  const escaped = path
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\t", "\\t")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
  return `"${escaped}"`;
}

/**
 * A patch for a file git does not know yet: what `git diff --no-index /dev/null <path>` would print
 * with relative paths. Untracked files are the one thing `git diff <base>` cannot show, and adding
 * them with `git add -N` would write the index, which this read model must not do. A long file is
 * cut inside the cap with the hunk header counting what is really there (`truncated`), and a
 * symlink carries git's own shape: mode 120000 and its target as the content.
 */
export function newFilePatch(
  path: string,
  bytes: Uint8Array,
  mode: "100644" | "120000" = "100644",
): { text: string | null; binary: boolean; truncated: boolean } {
  if (looksBinary(bytes)) return { text: null, binary: true, truncated: false };
  const total = countLines(bytes);
  const a = quotePatchPath(`a/${path}`);
  const b = quotePatchPath(`b/${path}`);
  const header = [`diff --git ${a} ${b}`, `new file mode ${mode}`, "--- /dev/null", `+++ ${b}`];
  if (total === 0) return { text: `${header.join("\n")}\n`, binary: false, truncated: false };
  const text = Buffer.from(bytes).toString("utf8");
  const body: string[] = [];
  let length = 0;
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const line = `+${text.slice(start, end)}`;
    body.push(line);
    length += line.length + 1;
    // The cap is on the patch; stop before it, and the header below counts what was included.
    if (length > MAX_DIFF_CHARACTERS - 4096) break;
    if (newline === -1) break;
    start = newline + 1;
  }
  const truncated = body.length < total;
  const patch = [...header, `@@ -0,0 +1,${body.length} @@`, ...body].join("\n");
  const marker = !text.endsWith("\n") && !truncated ? "\\ No newline at end of file\n" : "";
  return { text: `${patch}\n${marker}`, binary: false, truncated };
}

/**
 * Cuts a patch at the last hunk boundary inside the cap, so what is left is a complete set of
 * hunks; a single hunk longer than the cap is cut at a line boundary instead.
 */
export function capDiff(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_DIFF_CHARACTERS) return { text, truncated: false };
  const boundary = text.lastIndexOf("\n@@ ", MAX_DIFF_CHARACTERS);
  if (boundary !== -1) return { text: text.slice(0, boundary + 1), truncated: true };
  const cut = text.lastIndexOf("\n", MAX_DIFF_CHARACTERS);
  return {
    text: cut === -1 ? text.slice(0, MAX_DIFF_CHARACTERS) : text.slice(0, cut + 1),
    truncated: true,
  };
}

/**
 * What a task is compared with: the merge base with the project's default base branch for a
 * worktree task, `HEAD` for a task in the main working tree (its uncommitted changes are the
 * diff). A base branch that is gone, or exists but shares no history with `HEAD`, falls back to
 * `HEAD` and says which of the two it is instead of failing.
 */
export async function resolveBase(
  workspace: string,
  options: { worktree: boolean; defaultBaseBranch: string },
): Promise<ChangesBase> {
  const head = await gitRead(workspace, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
    .then((output) => output.trim())
    .catch(() => "");
  if (head === "") return { commit: null, label: "no commits yet", fallback: null };
  if (!options.worktree) return { commit: head, label: "HEAD", fallback: null };
  const branch = options.defaultBaseBranch;
  const mergeBase = await gitRead(workspace, ["merge-base", "HEAD", branch])
    .then((output) => output.trim())
    .catch(() => "");
  if (mergeBase !== "") return { commit: mergeBase, label: branch, fallback: null };
  const branchExists = await gitRead(workspace, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${branch}^{commit}`,
  ])
    .then((output) => output.trim() !== "")
    .catch(() => false);
  return {
    commit: head,
    label: "HEAD",
    fallback: branchExists
      ? `the base branch '${branch}' has no merge base with HEAD; compared with HEAD`
      : `the base branch '${branch}' is gone; compared with HEAD`,
  };
}

/**
 * A task's changed files under `base`: the diff against it, plus the files git does not track yet.
 * The list is capped before any untracked content is read, so a workspace with a million untracked
 * files costs one `git status`, not a million reads; `truncated` says the list was capped.
 */
export async function readChanges(
  workspace: string,
  options: { worktree: boolean; defaultBaseBranch: string },
): Promise<{ base: ChangesBase; files: ChangeFile[]; truncated: boolean }> {
  const base = await resolveBase(workspace, options);
  const tracked = base.commit === null ? [] : await trackedChanges(workspace, base.commit);
  const listing = await gitRead(workspace, [
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=all",
  ]);
  const untracked = new Set(untrackedPaths(listing));
  // A path that is both in the diff and untracked (`git rm --cached` then edit) is the addition:
  // the worktree file is what the user sees, and one path must not appear twice.
  const trackedByPath = new Map(
    tracked.filter((file) => !untracked.has(file.path)).map((file) => [file.path, file]),
  );
  const paths = [...new Set([...trackedByPath.keys(), ...untracked])].toSorted();
  const capped = paths.slice(0, MAX_CHANGED_FILES);
  const files: ChangeFile[] = [];
  for (const path of capped) {
    const changed = trackedByPath.get(path);
    if (changed !== undefined) {
      files.push(changed);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- one file at a time keeps the reads bounded
    files.push(await describeUntracked(join(workspace, path), path));
  }
  return { base, files, truncated: paths.length > MAX_CHANGED_FILES };
}

/** The tracked part of a task's changes; two git calls because `--name-status` and `--numstat` do not combine under `-z`. */
async function trackedChanges(workspace: string, commit: string): Promise<ChangeFile[]> {
  const common = [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames",
    commit,
    "-z",
  ];
  const names = parseNameStatus(await gitRead(workspace, [...common, "--name-status"]));
  const counts = parseNumstat(await gitRead(workspace, [...common, "--numstat"]));
  return mergeChangedFiles(names, counts);
}

/** The untracked paths of `git status --porcelain -z`; a rename's old path does not start with `??`. */
export function untrackedPaths(porcelainZ: string): string[] {
  return porcelainZ
    .split("\0")
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3));
}

/** What an untracked path really is: read as a file, followed never. */
type UntrackedContent =
  | { kind: "text"; bytes: Uint8Array; size: number; partial: boolean }
  | { kind: "symlink"; target: string; size: number }
  | { kind: "unreadable"; size: number | null; note: string };

/** The content of an untracked path, from `lstat` and a bounded read: a symlink is a link, not a target. */
async function untrackedContent(full: string): Promise<UntrackedContent> {
  let info;
  try {
    info = await lstat(full);
  } catch (error) {
    return { kind: "unreadable", size: null, note: `could not be read: ${reasonOf(error)}` };
  }
  if (info.isSymbolicLink()) {
    try {
      const target = await readlink(full);
      return { kind: "symlink", target, size: Buffer.byteLength(target) };
    } catch (error) {
      return { kind: "unreadable", size: null, note: `could not be read: ${reasonOf(error)}` };
    }
  }
  // A FIFO, a socket or a submodule entry is listed by git but has no bytes to count or diff.
  if (!info.isFile()) return { kind: "unreadable", size: info.size, note: "not a regular file" };
  const bytes = await readPrefix(full, info.size);
  if (bytes === undefined) {
    return { kind: "unreadable", size: info.size, note: "could not be read: permission denied" };
  }
  return { kind: "text", bytes, size: info.size, partial: info.size > MAX_UNTRACKED_BYTES };
}

/** One untracked path as a change row: never dropped, a reason in `note` when it cannot be counted. */
async function describeUntracked(full: string, path: string): Promise<ChangeFile> {
  const content = await untrackedContent(full);
  if (content.kind === "unreadable") {
    return {
      path,
      oldPath: null,
      status: "A",
      additions: 0,
      deletions: 0,
      binary: false,
      partial: true,
      note: content.note,
    };
  }
  if (content.kind === "symlink") {
    // Git stores a symlink as mode 120000 with the target as its content; that is one added line.
    return {
      path,
      oldPath: null,
      status: "A",
      additions: 1,
      deletions: 0,
      binary: false,
      partial: false,
      note: null,
    };
  }
  const binary = looksBinary(content.bytes);
  return {
    path,
    oldPath: null,
    status: "A",
    additions: binary ? 0 : countLines(content.bytes),
    deletions: 0,
    binary,
    partial: !binary && content.partial,
    note:
      !binary && content.partial
        ? `counted from the first ${Math.round(MAX_UNTRACKED_BYTES / (1024 * 1024))} MiB`
        : null,
  };
}

/**
 * One file's unified diff under `base`. An untracked addition is patched from its own bytes (a
 * symlink from its target, never from what it points at); a binary file has no text and reports
 * its size instead; a file that cannot be read says why instead of disappearing; everything is
 * capped at `MAX_DIFF_CHARACTERS`.
 */
export async function readFileDiff(
  workspace: string,
  base: ChangesBase,
  file: ChangeFile,
): Promise<ChangeDiff> {
  const size = await fileSize(workspace, base, file);
  if (file.binary) {
    return { path: file.path, text: null, binary: true, size, truncated: false, note: null };
  }
  if (base.commit !== null) {
    const paths = file.oldPath === null ? [file.path] : [file.oldPath, file.path];
    const patch = await gitRead(workspace, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      "--unified=3",
      base.commit,
      "--",
      ...paths,
    ]);
    if (patch !== "") {
      const capped = capDiff(patch);
      return {
        path: file.path,
        text: capped.text,
        binary: false,
        size,
        truncated: capped.truncated,
        note: null,
      };
    }
  }
  // Nothing in the diff means the file is untracked (or there is no commit yet): patch it ourselves.
  const content = await untrackedContent(join(workspace, file.path));
  if (content.kind === "unreadable") {
    return {
      path: file.path,
      text: null,
      binary: false,
      size,
      truncated: false,
      note: content.note,
    };
  }
  const patch =
    content.kind === "symlink"
      ? newFilePatch(file.path, Buffer.from(content.target), "120000")
      : newFilePatch(file.path, content.bytes);
  if (patch.text === null) {
    return { path: file.path, text: null, binary: true, size, truncated: false, note: null };
  }
  const capped = capDiff(patch.text);
  return {
    path: file.path,
    text: capped.text,
    binary: false,
    size,
    truncated: capped.truncated || patch.truncated,
    note: null,
  };
}

/** The file's size in the worktree (a symlink's own, not its target's), else in the base commit. */
async function fileSize(
  workspace: string,
  base: ChangesBase,
  file: ChangeFile,
): Promise<number | null> {
  try {
    return (await lstat(join(workspace, file.path))).size;
  } catch {
    // Deleted files have no worktree entry; a binary one in the base still has a size to show.
  }
  if (base.commit === null) return null;
  const object = await gitRead(workspace, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${base.commit}:${file.oldPath ?? file.path}`,
  ])
    .then((output) => output.trim())
    .catch(() => "");
  if (object === "") return null;
  return gitRead(workspace, ["cat-file", "-s", object])
    .then((output) => Number.parseInt(output.trim(), 10) || null)
    .catch(() => null);
}

/**
 * The first `limit` bytes of a regular file, read through a handle sized to what will be read: a
 * 300 MB file costs a 8 MiB buffer, not 300 MB, and is never read whole.
 */
async function readPrefix(path: string, size: number): Promise<Uint8Array | undefined> {
  const limit = Math.min(size, MAX_UNTRACKED_BYTES);
  let handle;
  try {
    handle = await open(path, "r");
    if (limit <= 0) return new Uint8Array(0);
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** The user-facing part of a filesystem error: `EACCES`, `EISDIR`, `ENOENT`. */
function reasonOf(error: unknown): string {
  const code =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : "unknown error";
}
