import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";

/**
 * The files a patch touches, parsed by `@pierre/diffs`' own parser, so repeated file headers
 * (`diff --git`/`---`/`+++`) name each file and are not counted as content. A malformed patch
 * parses to nothing and stays for the renderer to report.
 */
export function diffFiles(text: string): FileDiffMetadata[] {
  try {
    return parsePatchFiles(text).flatMap((patch) => patch.files);
  } catch {
    return [];
  }
}
