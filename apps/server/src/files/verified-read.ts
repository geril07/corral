import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  FileChangedError,
  FileNotFoundError,
  FileTooLargeError,
  FileUnreadableError,
} from "./errors.ts";
import { ioErrorCode, type WorkspaceEntry } from "./file-access.ts";

/**
 * Reads the bytes of an entry `resolveWorkspaceEntry` just proved is inside the workspace, and
 * makes the read *the same inode* the check saw. Resolving and reading are two moments: between
 * them the path can be replaced by a symlink to a file outside the workspace or by another file,
 * and a plain `readFile(entry.absolutePath)` would serve bytes the allow-list never approved.
 *
 * `O_NOFOLLOW` refuses a symlink in the path's place, and `fstat` on the open handle must report
 * the `dev`/`ino` the resolving `stat` did. `O_NOFOLLOW` is 0 on platforms without it, where the
 * inode check alone is the anchor. The size is read from that handle too, so the bound applies to
 * the bytes actually read and not to the length the earlier `stat` happened to see.
 */
export async function readVerifiedBytes(entry: WorkspaceEntry, limit: number): Promise<Buffer> {
  let handle;
  try {
    handle = await open(entry.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = ioErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") throw new FileNotFoundError(entry.relativePath);
    // A symlink where the checked file was: the check did not approve its target.
    if (code === "ELOOP") throw new FileChangedError(entry.relativePath);
    throw new FileUnreadableError(entry.relativePath);
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== entry.dev || info.ino !== entry.ino) {
      throw new FileChangedError(entry.relativePath);
    }
    if (info.size > limit) throw new FileTooLargeError(entry.relativePath, info.size, limit);
    const bytes = await handle.readFile();
    if (bytes.byteLength > limit) {
      throw new FileTooLargeError(entry.relativePath, bytes.byteLength, limit);
    }
    return bytes;
  } catch (error) {
    throw error instanceof FileTooLargeError || error instanceof FileChangedError
      ? error
      : new FileUnreadableError(entry.relativePath);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
