import { workspaceMissingMessage } from "@corral/protocol/workspace";
import type { SessionKind } from "@corral/protocol/rpc";

/**
 * A task's workspace directory is gone from disk. Session launch and the Changes read share the
 * sentence (`workspaceMissingMessage`); `kind` lets the launch wire answer through the existing
 * `LAUNCH_FAILED`, with no code of its own.
 */
export class WorkspaceMissingError extends Error {
  readonly path: string;
  readonly kind: SessionKind;
  constructor(path: string, kind: SessionKind) {
    super(workspaceMissingMessage(path));
    this.name = "WorkspaceMissingError";
    this.path = path;
    this.kind = kind;
  }
}

/**
 * Reading a local path behind a chat link. Each refusal names its own reason so the client can
 * tell "not a file of this workspace" apart from "gone" or "too large" — and so a test can pin
 * the security boundary (`docs/design.md`, **Local trust boundary**) instead of a bare failure.
 */

export class FileOutsideWorkspaceError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`${path} is outside this task's workspace`);
    this.path = path;
  }
}

export class FileNotFoundError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`${path} does not exist`);
    this.path = path;
  }
}

export class FileIsDirectoryError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`${path} is a directory`);
    this.path = path;
  }
}

export class FileTooLargeError extends Error {
  readonly path: string;
  readonly size: number;
  readonly limit: number;
  constructor(path: string, size: number, limit: number) {
    super(`${path} is ${size} bytes, past the ${limit} byte preview limit`);
    this.path = path;
    this.size = size;
    this.limit = limit;
  }
}

/** Not an image or a video: nothing this build previews inline. */
export class FileTypeUnsupportedError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`${path} has no previewable media type`);
    this.path = path;
  }
}

/**
 * The path was replaced between the allow-list check and the read: another inode, or a symlink
 * where the checked file was. Refused rather than followed.
 */
export class FileChangedError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`${path} changed while it was being read`);
    this.path = path;
  }
}

export class FileUnreadableError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`${path} could not be read`);
    this.path = path;
  }
}

/** Nothing to run: no `[editor] command`, `$VISUAL` or `$EDITOR` on the server. */
export class EditorUnsetError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

/** The configured editor is not executable, told apart from "nothing configured". */
export class EditorNotFoundError extends Error {
  readonly command: string;
  constructor(command: string) {
    super(`${command} is not an executable the server can run`);
    this.command = command;
  }
}
