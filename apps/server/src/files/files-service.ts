import type { ConfigState } from "@corral/protocol/config";
import { editorCommand } from "@corral/protocol/config";
import {
  FILE_PREVIEW_LIMITS,
  type FileBytes,
  type FileMedia,
  type FileResolution,
  type FileTarget,
  type Task,
  type TerminalSize,
} from "@corral/protocol/rpc";
import { isExecutable } from "../agents/executable-lookup.ts";
import type { TerminalRegistry } from "../terminals/terminal-registry.ts";
import { editorSources, editorUnsetReason, resolveEditorCommand } from "./editor-command.ts";
import {
  EditorNotFoundError,
  EditorUnsetError,
  FileIsDirectoryError,
  FileOutsideWorkspaceError,
  FileTooLargeError,
  FileTypeUnsupportedError,
} from "./errors.ts";
import { resolveWorkspaceEntry, type WorkspaceEntry } from "./file-access.ts";
import { readVerifiedBytes } from "./verified-read.ts";

export interface FilesServiceOptions {
  /** The task whose workspace is the allow-list; `get` throws the task-not-found refusal. */
  tasks: { get(id: string): Task };
  terminals: TerminalRegistry;
  /** The effective config, read on every call so editing `[editor]` applies without a restart. */
  config: { state(): ConfigState };
  /** Where `$VISUAL`/`$EDITOR` come from; tests pass their own, the server passes its own. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** Whether `files.read` will serve this entry: a file, of a media kind, within the preview bound. */
function previewable(kind: WorkspaceEntry["kind"], media: FileMedia | undefined, size: number) {
  return kind === "file" && media !== undefined && size <= FILE_PREVIEW_LIMITS[media];
}

function target(entry: WorkspaceEntry): FileTarget {
  return {
    requested: entry.relativePath,
    path: entry.relativePath,
    name: entry.name,
    kind: entry.kind,
    size: entry.size,
    media: entry.media ?? null,
    mime: entry.mime ?? null,
    previewable: previewable(entry.kind, entry.media, entry.size),
  };
}

/**
 * The server's read side of chat's local links (`packages/protocol/src/rpc.ts`, `files`). Every
 * entry point resolves through `resolveWorkspaceEntry`, so the allow-list, `realpath` and the size
 * and type bounds are one implementation and no procedure can skip one of them.
 */
export class FilesService {
  readonly #tasks: FilesServiceOptions["tasks"];
  readonly #terminals: TerminalRegistry;
  readonly #config: FilesServiceOptions["config"];
  readonly #env: Readonly<Record<string, string | undefined>>;

  constructor(options: FilesServiceOptions) {
    this.#tasks = options.tasks;
    this.#terminals = options.terminals;
    this.#config = options.config;
    this.#env = options.env ?? process.env;
  }

  /**
   * Resolves candidates in one pass. A path outside the workspace and a path that is not there are
   * answers, not failures: the renderer leaves that text plain, and a lookup of `/etc/passwd` in a
   * message is not an error the user must read.
   */
  async resolve(taskId: string, paths: readonly string[]): Promise<FileResolution[]> {
    const task = this.#tasks.get(taskId);
    return Promise.all(
      paths.map(async (requested): Promise<FileResolution> => {
        try {
          const entry = await resolveWorkspaceEntry(task.workspacePath, requested);
          return { status: "ok", target: { ...target(entry), requested } };
        } catch (error) {
          if (error instanceof FileOutsideWorkspaceError) return { status: "outside", requested };
          return { status: "missing", requested };
        }
      }),
    );
  }

  /** One previewable file's bytes: bounded by `FILE_PREVIEW_LIMITS`, base64, no streaming. */
  async read(taskId: string, path: string): Promise<FileBytes> {
    const task = this.#tasks.get(taskId);
    const entry = await resolveWorkspaceEntry(task.workspacePath, path);
    if (entry.kind !== "file") throw new FileIsDirectoryError(path);
    if (entry.media === undefined || entry.mime === undefined)
      throw new FileTypeUnsupportedError(path);
    const limit = FILE_PREVIEW_LIMITS[entry.media];
    // Refuse early with the resolved size; `readVerifiedBytes` bounds the bytes it actually reads.
    if (entry.size > limit) throw new FileTooLargeError(path, entry.size, limit);
    const bytes = await readVerifiedBytes(entry, limit);
    return {
      path: entry.relativePath,
      name: entry.name,
      media: entry.media,
      mime: entry.mime,
      size: bytes.byteLength,
      bytes: bytes.toString("base64"),
    };
  }

  /**
   * Runs the user's editor on a workspace file as a terminal in the task's workspace: a terminal
   * editor needs a PTY, and a GUI editor detaches from it. The terminal is loose (it belongs to no
   * session), which keeps `design.md`'s one-owner rule for a task's terminals intact.
   */
  async openEditor(
    taskId: string,
    path: string,
    position: { line?: number | undefined; column?: number | undefined; size: TerminalSize },
  ): Promise<{ terminalId: string }> {
    const task = this.#tasks.get(taskId);
    const entry = await resolveWorkspaceEntry(task.workspacePath, path);
    if (entry.kind !== "file") throw new FileIsDirectoryError(path);
    const sources = editorSources(editorCommand(this.#config.state().config), this.#env);
    const resolved = resolveEditorCommand(sources, {
      file: entry.absolutePath,
      line: position.line,
      column: position.column,
    });
    if (resolved === undefined || "problem" in resolved) {
      throw new EditorUnsetError(editorUnsetReason(sources, resolved));
    }
    const { command, args } = resolved;
    if (!isExecutable(command, this.#env["PATH"])) throw new EditorNotFoundError(command);
    const info = this.#terminals.create(
      { command, args, cwd: task.workspacePath, size: position.size },
      null,
    );
    return { terminalId: info.id };
  }
}
