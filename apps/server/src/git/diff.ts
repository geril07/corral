import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ChangeDiff, ChangeFile, ChangeStatus, ChangesBase } from "@corral/protocol/rpc";
import { git } from "./git.ts";

/**
 * The most changed files one task's read model lists. Past this a repository's diff is not a tab
 * anyone reads, and the event would grow with the repository instead of the task.
 */
export const MAX_CHANGED_FILES = 500;

/** The most characters one file's patch carries; a longer diff is cut at a line boundary. */
export const MAX_DIFF_CHARACTERS = 512 * 1024;

/** The most of an untracked file the server reads to count and diff it. */
const MAX_UNTRACKED_BYTES = 8 * 1024 * 1024;

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
 * `git diff --numstat -z` output, keyed by the path after the change. A rename's two paths follow
 * the empty path field as their own entries; a binary file's counts are `-`/`-`.
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
    let path = fields[2] ?? "";
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
      };
    })
    .toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Whether a file's start looks binary by git's rule. */
export function looksBinary(bytes: Uint8Array): boolean {
  const sniffed = bytes.subarray(0, BINARY_SNIFF_BYTES);
  return sniffed.includes(0);
}

/**
 * A patch for a file git does not know yet: what `git diff --no-index /dev/null <path>` would print
 * with relative paths. Untracked files are the one thing `git diff <base>` cannot show, and adding
 * them with `git add -N` would write the index, which this read model must not do.
 */
export function newFilePatch(
  path: string,
  bytes: Uint8Array,
): { text: string | null; binary: boolean } {
  if (looksBinary(bytes)) return { text: null, binary: true };
  const text = Buffer.from(bytes).toString("utf8");
  const lines = splitLines(text);
  const header = [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
  ];
  if (lines.length === 0) return { text: `${header.join("\n")}\n`, binary: false };
  const body = lines.map((line) => `+${line}`).join("\n");
  const patch = [...header, `@@ -0,0 +1,${lines.length} @@`, body].join("\n");
  // A file whose last line has no newline says so, exactly as git does.
  return {
    text: text.endsWith("\n") ? `${patch}\n` : `${patch}\n\\ No newline at end of file\n`,
    binary: false,
  };
}

/** A text's lines as a patch adds them: the trailing newline does not open an empty line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Cuts a patch at the last line boundary inside the cap; a shorter one comes back unchanged. */
export function capDiff(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_DIFF_CHARACTERS) return { text, truncated: false };
  const cut = text.lastIndexOf("\n", MAX_DIFF_CHARACTERS);
  return { text: text.slice(0, cut === -1 ? MAX_DIFF_CHARACTERS : cut + 1), truncated: true };
}

/**
 * What a task is compared with: the merge base with the project's default base branch for a
 * worktree task, `HEAD` for a task in the main working tree (its uncommitted changes are the
 * diff). A base branch that is gone, or shares no history with `HEAD`, falls back to `HEAD` and
 * says why instead of failing.
 */
export async function resolveBase(
  workspace: string,
  options: { worktree: boolean; defaultBaseBranch: string },
): Promise<ChangesBase> {
  const head = await git(workspace, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
    .then((output) => output.trim())
    .catch(() => "");
  if (head === "") return { commit: null, label: "no commits yet", fallback: null };
  if (!options.worktree) return { commit: head, label: "HEAD", fallback: null };
  const mergeBase = await git(workspace, ["merge-base", "HEAD", options.defaultBaseBranch])
    .then((output) => output.trim())
    .catch(() => "");
  if (mergeBase !== "") {
    return { commit: mergeBase, label: options.defaultBaseBranch, fallback: null };
  }
  return {
    commit: head,
    label: "HEAD",
    fallback: `the base branch '${options.defaultBaseBranch}' is gone; compared with HEAD`,
  };
}

/** A task's changed files under `base`: the diff against it, plus the files git does not track yet. */
export async function readChanges(
  workspace: string,
  options: { worktree: boolean; defaultBaseBranch: string },
): Promise<{ base: ChangesBase; files: ChangeFile[]; truncated: boolean }> {
  const base = await resolveBase(workspace, options);
  const tracked = base.commit === null ? [] : await trackedChanges(workspace, base.commit);
  const untrackedChanges = await readUntracked(workspace);
  const files = [...tracked, ...untrackedChanges].toSorted((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return {
    base,
    files: files.slice(0, MAX_CHANGED_FILES),
    truncated: files.length > MAX_CHANGED_FILES,
  };
}

/** The tracked part of a task's changes; two git calls because `--name-status` and `--numstat` do not combine under `-z`. */
async function trackedChanges(workspace: string, commit: string): Promise<ChangeFile[]> {
  const common = ["diff", "--no-color", "--no-ext-diff", "--find-renames", commit, "-z"];
  const names = parseNameStatus(await git(workspace, [...common, "--name-status"]));
  const counts = parseNumstat(await git(workspace, [...common, "--numstat"]));
  return mergeChangedFiles(names, counts);
}

/** Files `git status` reports as untracked, as additions with their line counts. */
async function readUntracked(workspace: string): Promise<ChangeFile[]> {
  const listing = await git(workspace, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  const paths = [...new Set(untrackedPaths(listing))];
  const found: ChangeFile[] = [];
  for (const path of paths) {
    // oxlint-disable-next-line no-await-in-loop -- one file at a time keeps the reads bounded
    const bytes = await readPrefix(join(workspace, path), MAX_UNTRACKED_BYTES);
    // A symlink or a submodule is not a file to count and diff; `status` lists it, a patch cannot.
    if (bytes === undefined) continue;
    const binary = looksBinary(bytes);
    found.push({
      path,
      oldPath: null,
      status: "A",
      additions: binary ? 0 : splitLines(Buffer.from(bytes).toString("utf8")).length,
      deletions: 0,
      binary,
    });
  }
  return found;
}

/** The untracked paths of `git status --porcelain -z`; a rename's old path does not start with `??`. */
export function untrackedPaths(porcelainZ: string): string[] {
  return porcelainZ
    .split("\0")
    .filter((entry) => entry.startsWith("?? "))
    .map((entry) => entry.slice(3));
}

/**
 * One file's unified diff under `base`. An untracked addition is patched from its own bytes; a
 * binary file has no text and reports its size instead; everything is capped at
 * `MAX_DIFF_CHARACTERS`.
 */
export async function readFileDiff(
  workspace: string,
  base: ChangesBase,
  file: ChangeFile,
): Promise<ChangeDiff> {
  const size = await fileSize(workspace, base, file);
  if (file.binary) return { path: file.path, text: null, binary: true, size, truncated: false };
  if (base.commit !== null) {
    const paths = file.oldPath === null ? [file.path] : [file.oldPath, file.path];
    const patch = await git(workspace, [
      "diff",
      "--no-color",
      "--no-ext-diff",
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
      };
    }
  }
  // Nothing in the diff means the file is untracked (or there is no commit yet): patch it ourselves.
  const bytes = await readPrefix(join(workspace, file.path), MAX_UNTRACKED_BYTES);
  if (bytes === undefined) {
    return { path: file.path, text: null, binary: false, size, truncated: false };
  }
  const patch = newFilePatch(file.path, bytes);
  if (patch.text === null) {
    return { path: file.path, text: null, binary: true, size, truncated: false };
  }
  const capped = capDiff(patch.text);
  return { path: file.path, text: capped.text, binary: false, size, truncated: capped.truncated };
}

/** The file's size in the worktree, else in the base commit, else `null`. */
async function fileSize(
  workspace: string,
  base: ChangesBase,
  file: ChangeFile,
): Promise<number | null> {
  try {
    return (await stat(join(workspace, file.path))).size;
  } catch {
    // Deleted files have no worktree entry; a binary one in the base still has a size to show.
  }
  if (base.commit === null) return null;
  const object = await git(workspace, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${base.commit}:${file.oldPath ?? file.path}`,
  ])
    .then((output) => output.trim())
    .catch(() => "");
  if (object === "") return null;
  return git(workspace, ["cat-file", "-s", object])
    .then((output) => Number.parseInt(output.trim(), 10) || null)
    .catch(() => null);
}

/** The first `limit` bytes of a regular file, or `undefined` when there is no such file. */
async function readPrefix(path: string, limit: number): Promise<Uint8Array | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return undefined;
    const bytes = await readFile(path);
    return bytes.byteLength > limit ? bytes.subarray(0, limit) : bytes;
  } catch {
    return undefined;
  }
}
