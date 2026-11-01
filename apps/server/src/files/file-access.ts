import type { FileMedia } from "@corral/protocol/rpc";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { FileNotFoundError, FileOutsideWorkspaceError, FileUnreadableError } from "./errors.ts";
import { mediaOf } from "./media.ts";

/** One existing entry of a task's workspace. */
export interface WorkspaceEntry {
  /** The real path on disk, symlinks resolved. */
  absolutePath: string;
  /** Relative to the workspace, `/`-separated; `""` for the workspace itself. */
  relativePath: string;
  name: string;
  kind: "file" | "directory";
  /** Bytes; 0 for a directory. */
  size: number;
  /**
   * The device and inode the resolving `stat` saw. A read opens the path again, so it checks these
   * before serving anything: a file replaced between the allow-list check and the read (another
   * inode, or a symlink in its place) is refused rather than followed.
   */
  dev: number;
  ino: number;
  media: FileMedia | undefined;
  mime: string | undefined;
}

/** The `code` of a failed filesystem call, for mapping it to a refusal. */
export function ioErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

/** True for the workspace itself and everything under it, false for a sibling such as `/ws2`. */
function isInside(base: string, candidate: string): boolean {
  const path = relative(base, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

/**
 * Resolves `requested` against the task's workspace and proves it is inside it. This is the
 * allow-list: the workspace's `realpath` is the root, and the requested path goes through
 * `realpath` too, so neither `..` nor a symlink points the result somewhere the workspace does
 * not contain. A path outside is `FileOutsideWorkspaceError` — a refusal that names the reason —
 * never a silent miss.
 *
 * `..` is normalised **lexically**, as `path.resolve` does, before `realpath`: `link/../x.ts`
 * names `x.ts` beside `link`, not beside the file `link` points at. A shell would follow the link
 * first; component-wise resolution (`openat` with `O_NOFOLLOW` per segment) is the only way to
 * match it, and this slice does not need that, so the behaviour is stated and pinned by a test.
 */
export async function resolveWorkspaceEntry(
  workspacePath: string,
  requested: string,
): Promise<WorkspaceEntry> {
  if (requested === "" || requested.includes("\0")) throw new FileNotFoundError(requested);
  let base: string;
  try {
    base = await realpath(workspacePath);
  } catch (error) {
    throw ioErrorCode(error) === "ENOENT"
      ? new FileNotFoundError(workspacePath)
      : new FileUnreadableError(workspacePath);
  }
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(base, requested);
  let absolutePath: string;
  try {
    absolutePath = await realpath(candidate);
  } catch (error) {
    const code = ioErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
      // Nothing to resolve, so the lexical location decides: a `..` that leaves the workspace is
      // still a refusal with a reason, not a miss that hides why.
      if (!isInside(base, candidate)) throw new FileOutsideWorkspaceError(requested);
      throw new FileNotFoundError(requested);
    }
    throw new FileUnreadableError(requested);
  }
  if (!isInside(base, absolutePath)) throw new FileOutsideWorkspaceError(requested);
  const relativePath = relative(base, absolutePath).split(sep).join("/");
  let info;
  try {
    info = await stat(absolutePath);
  } catch (error) {
    if (ioErrorCode(error) === "ENOENT") throw new FileNotFoundError(requested);
    throw new FileUnreadableError(requested);
  }
  const directory = info.isDirectory();
  const name = relativePath === "" ? basename(base) : (relativePath.split("/").pop() ?? base);
  const media = directory ? undefined : mediaOf(name);
  return {
    absolutePath,
    relativePath,
    name,
    kind: directory ? "directory" : "file",
    size: directory ? 0 : info.size,
    dev: info.dev,
    ino: info.ino,
    media: media?.media,
    mime: media?.mime,
  };
}
