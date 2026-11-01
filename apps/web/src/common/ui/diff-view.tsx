import { PatchDiff } from "@pierre/diffs/react";
import { useMemo, useState } from "react";
import { Button } from "./button.tsx";
import { diffContentLines } from "./diff-lines.ts";
import { useDarkTheme } from "./diff-theme.ts";

/** The changed-file preview folds after this many diff line boxes (`layout.md`, **Chat**). */
const FOLD_LINES = 20;
/** The app switches no theme, but the diff reads the same `dark` class the tokens do. */

/**
 * A tool result's unified diff, rendered by `@pierre/diffs` on the highlighter Streamdown uses
 * (goal D1). The diff is a plain element in the chat lane, so the kit owns its width, its wrap and
 * the 20-line fold; modules pass the text and the optional path, nothing visual.
 */
export function DiffView({ text, path }: { text: string; path: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => diffContentLines(text), [text]);
  const folded = lines > FOLD_LINES && !expanded;
  const dark = useDarkTheme();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {path !== null && (
        <p className="m-0 truncate font-mono text-xs text-muted-foreground">{path}</p>
      )}
      <div className="min-w-0 overflow-hidden rounded-md border border-border">
        <div
          data-testid="diff-body"
          // 20 line boxes plus the 8 px top padding of the code surface: 20 × 20 + 8 = 408 px.
          className={folded ? "max-h-[25.5rem] min-w-0 overflow-hidden" : "min-w-0 overflow-hidden"}
        >
          <PatchDiff
            patch={text}
            disableWorkerPool
            options={{
              theme: { light: "pierre-light", dark: "pierre-dark" },
              themeType: dark ? "dark" : "light",
              diffStyle: "unified",
              diffIndicators: "classic",
              disableFileHeader: true,
              // The chat lane is 46 rem, so a long line wraps instead of scrolling sideways.
              overflow: "wrap",
              hunkSeparators: "line-info",
            }}
          />
        </div>
      </div>
      {folded && (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
            Show all {lines} lines
          </Button>
        </div>
      )}
    </div>
  );
}
