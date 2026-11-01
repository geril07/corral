import { parsePatchFiles } from "@pierre/diffs";

/**
 * Counts the unified-view line boxes of a patch through `@pierre/diffs`' own parser, so repeated
 * file headers (`diff --git`/`---`/`+++`) in a multi-file patch are not counted as content. Each
 * hunk's `unifiedLineCount` is the rows it renders; a malformed patch counts as zero and stays
 * unfolded for `PatchDiff` to report.
 */
export function diffContentLines(text: string): number {
  try {
    return parsePatchFiles(text).reduce(
      (total, patch) =>
        total + patch.files.reduce((lines, file) => lines + file.unifiedLineCount, 0),
      0,
    );
  } catch {
    return 0;
  }
}
