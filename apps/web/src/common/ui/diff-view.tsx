import { FileDiff } from "@pierre/diffs/react";
import { useMemo, useState } from "react";
import type { FileDiffMetadata } from "@pierre/diffs";
import { Button } from "./button.tsx";
import { diffFiles } from "./diff-lines.ts";
import { useDarkTheme } from "./diff-theme.ts";

/** The changed-file preview folds after this many diff line boxes. */
const FOLD_LINES = 20;

/**
 * A tool result's unified diff, rendered by `@pierre/diffs` on the highlighter Streamdown uses.
 * A patch may name several files, and the renderer takes one file at a time, so the kit splits it
 * and gives each file its own named section — the shape OpenCode's file accordion has, without a
 * second disclosure: the row the user opened already means "show me the change". The card around
 * it draws the frame; modules pass the text, nothing visual.
 */
export function DiffView({ text }: { text: string }) {
  const files = useMemo(() => diffFiles(text), [text]);
  const dark = useDarkTheme();
  if (files.length === 0) {
    // Text no diff renderer can read still shows as the text it is: the pane stays, and the
    // change is readable instead of the whole transcript falling to an error boundary.
    return (
      <pre className="m-0 max-h-64 overflow-auto p-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
        {text}
      </pre>
    );
  }
  return (
    <div className="flex min-w-0 flex-col">
      {files.map((file, index) => (
        <DiffFile
          key={file.cacheKey ?? `${file.name}:${index}`}
          file={file}
          dark={dark}
          divided={index > 0}
        />
      ))}
    </div>
  );
}

function diffOptions(dark: boolean) {
  return {
    theme: { light: "pierre-light", dark: "pierre-dark" } as const,
    themeType: dark ? ("dark" as const) : ("light" as const),
    diffStyle: "unified" as const,
    diffIndicators: "classic" as const,
    // Each file's section names it, so the renderer draws no header of its own.
    disableFileHeader: true,
    // The chat lane is 46 rem, so a long line wraps instead of scrolling sideways.
    overflow: "wrap" as const,
    hunkSeparators: "line-info" as const,
  };
}

/** One file of a patch: its path and change counts over its diff, folded at 20 line boxes. */
function DiffFile({
  file,
  dark,
  divided,
}: {
  file: FileDiffMetadata;
  dark: boolean;
  /** A section after the first is separated from the one above by the card's hairline. */
  divided: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const additions = useMemo(
    () => file.hunks.reduce((total, hunk) => total + hunk.additionLines, 0),
    [file],
  );
  const deletions = useMemo(
    () => file.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0),
    [file],
  );
  const folded = file.unifiedLineCount > FOLD_LINES && !expanded;
  return (
    <div className={divided ? "min-w-0 border-t border-border" : "min-w-0"}>
      <div className="flex items-baseline gap-2 border-b border-border/60 px-2 py-1.5">
        <span
          data-testid="diff-file-name"
          className="min-w-0 truncate font-mono text-xs text-foreground"
        >
          {file.name}
        </span>
        <span
          className="ms-auto shrink-0 font-mono text-xs tabular-nums"
          aria-label={`${additions} additions, ${deletions} deletions`}
        >
          <span className="text-status-done">+{additions}</span>{" "}
          <span className="text-destructive">-{deletions}</span>
        </span>
      </div>
      <div
        data-testid="diff-body"
        // 20 line boxes plus the 8 px top padding of the code surface: 20 × 20 + 8 = 408 px.
        className={folded ? "max-h-[25.5rem] min-w-0 overflow-hidden" : "min-w-0 overflow-hidden"}
      >
        <FileDiff fileDiff={file} disableWorkerPool options={diffOptions(dark)} />
      </div>
      {folded && (
        <div className="px-2 pb-2 pt-1">
          <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
            Show all {file.unifiedLineCount} lines
          </Button>
        </div>
      )}
    </div>
  );
}
