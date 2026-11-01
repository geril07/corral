import type { ChangesStore } from "@corral/client/changes-store";
import { describeError } from "@corral/client/rpc-errors";
import type { ChangeDiff, Task, TaskChanges } from "@corral/protocol/rpc";
import { useEffect, useRef, useState } from "react";
import { ChangeFileRow, DiffPane } from "../../common/ui/index.ts";

export interface ChangesViewProps {
  task: Task;
  /** The task's read model; `undefined` until the server's first list arrives. */
  changes: TaskChanges | undefined;
  /** The server refused `changes.watch`: a daemon from before C4 has no changes read model. */
  failed: boolean;
  store: ChangesStore;
}

/**
 * The `Changes` tab's content (`layout.md`, **Changes**): a summary row, 28 px file rows and the
 * selected file's diff at the full main-area width. Read-only in this slice: nothing stages,
 * commits or opens an editor. It refreshes on mount (the tab becoming current), when the window
 * regains focus, and whenever the server's read model changes under it (an agent's tool call).
 */
export function ChangesView({ task, changes, failed, store }: ChangesViewProps) {
  const files = changes?.files ?? [];
  const [selectedPath, setSelectedPath] = useState<string>();
  /** The one selection's answer; a diff for another path is not shown while the next one loads. */
  const [detail, setDetail] = useState<{ path: string; diff?: ChangeDiff; failure?: string }>();
  const list = useRef<HTMLDivElement>(null);
  const focusedOnce = useRef(false);
  // A selection that the new read model no longer lists falls back to the first file.
  const activePath = files.some((file) => file.path === selectedPath)
    ? selectedPath
    : files[0]?.path;

  // The tab becoming current is a mount: ask the server to recompute, and again when the window
  // regains focus, because an edit made outside Corral (or by a terminal agent) never reaches us.
  useEffect(() => {
    const refresh = () => void store.refresh(task.id).catch(() => undefined);
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [store, task.id]);

  // The diff of the selected file, refetched when the read model changes under it.
  useEffect(() => {
    if (activePath === undefined || changes === undefined) return undefined;
    let live = true;
    store.diff(task.id, activePath).then(
      (next) => {
        if (live) setDetail({ path: activePath, diff: next });
      },
      (error: unknown) => {
        if (live) setDetail({ path: activePath, failure: describeError(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [store, task.id, activePath, changes]);
  const current = detail?.path === activePath ? detail : undefined;

  const rowElement = (path: string) =>
    list.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);

  // The tab replaces the terminal, so the list takes the keyboard when it first has rows: the
  // arrow keys work without a click, and the terminal is not there to hold them.
  useEffect(() => {
    if (focusedOnce.current || activePath === undefined) return;
    focusedOnce.current = true;
    list.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(activePath)}"]`)?.focus();
  }, [activePath]);

  const move = (step: 1 | -1 | "first" | "last") => {
    if (files.length === 0) return;
    const index = files.findIndex((file) => file.path === activePath);
    const next =
      step === "first"
        ? files[0]
        : step === "last"
          ? files[files.length - 1]
          : files[Math.min(Math.max((index < 0 ? 0 : index) + step, 0), files.length - 1)];
    if (next === undefined || next.path === activePath) return;
    setSelectedPath(next.path);
    // The row keeps the keyboard: focus moves with the selection, not with a rerender.
    requestAnimationFrame(() => rowElement(next.path)?.focus());
  };

  if (failed) {
    return (
      <Notice>
        Changes are not available from this server; it does not offer the changes API.
      </Notice>
    );
  }
  if (changes === undefined) {
    return (
      <div className="flex h-full flex-col gap-2 p-2" aria-label="Changes loading" role="status">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="h-7 animate-pulse rounded-sm bg-muted" />
        ))}
      </div>
    );
  }
  if (changes.error !== null) {
    return (
      <div className="p-2">
        <p className="m-0 text-sm text-destructive" role="alert">
          {changes.error}
        </p>
      </div>
    );
  }
  if (files.length === 0) return <Notice>No changes yet</Notice>;

  return (
    <div className="flex h-full min-h-0 flex-col p-2">
      <p className="m-0 mb-2 shrink-0 text-sm text-muted-foreground">
        {files.length} {files.length === 1 ? "file" : "files"}, +{changes.additions} −
        {changes.deletions}
        {changes.truncated ? " (the first 500 files)" : ""}
        {changes.base.fallback === null ? "" : ` · ${changes.base.fallback}`}
      </p>
      <div
        ref={list}
        role="listbox"
        aria-label="Changed files"
        aria-orientation="vertical"
        className="changes-list min-h-0 overflow-y-auto"
        onKeyDown={(event) => {
          const keys: Record<string, () => void> = {
            ArrowDown: () => move(1),
            ArrowUp: () => move(-1),
            Home: () => move("first"),
            End: () => move("last"),
          };
          const action = keys[event.key];
          if (action === undefined) return;
          event.preventDefault();
          action();
        }}
      >
        {files.map((file) => (
          <ChangeFileRow
            key={file.path}
            file={file}
            selected={file.path === activePath}
            onSelect={() => setSelectedPath(file.path)}
          />
        ))}
      </div>
      <div
        className="min-h-0 flex-1 overflow-auto border-t border-border pt-2"
        role="region"
        aria-label="File diff"
      >
        <DiffBody diff={current?.diff} failure={current?.failure} />
      </div>
    </div>
  );
}

function DiffBody({
  diff,
  failure,
}: {
  diff: ChangeDiff | undefined;
  failure: string | undefined;
}) {
  if (failure !== undefined) {
    return (
      <p className="m-0 text-sm text-destructive" role="alert">
        {failure}
      </p>
    );
  }
  if (diff === undefined) return null;
  if (diff.binary) {
    return (
      <p className="m-0 text-sm text-muted-foreground">
        Binary file{diff.size === null ? "" : `, ${formatBytes(diff.size)}`}
      </p>
    );
  }
  if (diff.text === null)
    return <p className="m-0 text-sm text-muted-foreground">No diff to show.</p>;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <DiffPane text={diff.text} />
      {diff.truncated && (
        <p className="m-0 text-xs text-muted-foreground">Diff truncated at 512 KiB.</p>
      )}
    </div>
  );
}

/** "12 KB": what a binary row shows instead of a diff (`layout.md`, **Changes**). */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function Notice({ children }: { children: string }) {
  return (
    <div className="flex h-full items-center justify-center p-2">
      <p className="m-0 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
