import type { ChangeFile } from "@corral/protocol/rpc";
import { PatchDiff } from "@pierre/diffs/react";
import { Button } from "./button.tsx";
import { useDarkTheme } from "./diff-theme.ts";

/**
 * One 28 px changed-file row (`layout.md`, **Changes**): the status letter, the path in 13 px mono
 * truncated from the left so the file name stays visible, and the counts right-aligned. A rename
 * names both paths. Selected is the row whose diff the pane shows, not a keyboard focus state.
 */
export function ChangeFileRow({
  file,
  selected,
  onSelect,
}: {
  file: Pick<
    ChangeFile,
    "path" | "oldPath" | "status" | "additions" | "deletions" | "binary" | "note"
  >;
  selected: boolean;
  onSelect: () => void;
}) {
  const shown = file.oldPath === null ? file.path : `${file.oldPath} → ${file.path}`;
  return (
    <Button
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      variant={selected ? "secondary" : "ghost"}
      size="xs"
      layout="tree"
      data-path={file.path}
      title={file.note === null ? shown : `${shown} — ${file.note}`}
      className="h-7 w-full gap-2 rounded-sm px-2"
      onClick={onSelect}
    >
      <span className="w-3 shrink-0 font-mono text-xs text-muted-foreground">{file.status}</span>
      {/* `dir="rtl"` puts the ellipsis at the start of a long path, keeping the file name in view. */}
      <span dir="rtl" className="min-w-0 flex-1 truncate text-left font-mono text-[13px]">
        {shown}
      </span>
      <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
        {file.binary || (file.additions === 0 && file.deletions === 0)
          ? ""
          : `+${file.additions} −${file.deletions}`}
      </span>
    </Button>
  );
}

/**
 * One file's unified diff at the Changes tab's full width (`layout.md`, **Changes**): no wrap,
 * horizontal scroll, unchanged regions folded into the library's own expandable separators. It is
 * a second renderer over the same `@pierre/diffs` highlighter `DiffView` uses; chat's 46 rem lane
 * keeps its wrap and its 20-line fold, and neither shape is a flag on the other.
 */
export function DiffPane({ text }: { text: string }) {
  const dark = useDarkTheme();
  return (
    <div className="min-w-0">
      <PatchDiff
        patch={text}
        disableWorkerPool
        options={{
          theme: { light: "pierre-light", dark: "pierre-dark" },
          themeType: dark ? "dark" : "light",
          diffStyle: "unified",
          diffIndicators: "classic",
          disableFileHeader: true,
          // The default, repeated because it is the opposite of chat's: full width, never wrapped.
          overflow: "scroll",
          hunkSeparators: "line-info",
        }}
      />
    </div>
  );
}
