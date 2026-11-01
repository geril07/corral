import type { FileMedia } from "@corral/protocol/rpc";
import { extname } from "node:path";

/**
 * The extensions this build previews inline. A table, not content sniffing: the bytes are only
 * read after the size check, and a wrong-looking extension costs a broken preview, not a security
 * hole. Anything missing here opens in the editor instead.
 */
const MEDIA: Readonly<Record<string, { media: FileMedia; mime: string }>> = {
  ".png": { media: "image", mime: "image/png" },
  ".jpg": { media: "image", mime: "image/jpeg" },
  ".jpeg": { media: "image", mime: "image/jpeg" },
  ".gif": { media: "image", mime: "image/gif" },
  ".webp": { media: "image", mime: "image/webp" },
  ".avif": { media: "image", mime: "image/avif" },
  ".bmp": { media: "image", mime: "image/bmp" },
  ".svg": { media: "image", mime: "image/svg+xml" },
  ".mp4": { media: "video", mime: "video/mp4" },
  ".m4v": { media: "video", mime: "video/mp4" },
  ".webm": { media: "video", mime: "video/webm" },
  ".mov": { media: "video", mime: "video/quicktime" },
  ".ogv": { media: "video", mime: "video/ogg" },
};

/** What a preview can show for this file name, or `undefined` when it is not media. */
export function mediaOf(name: string): { media: FileMedia; mime: string } | undefined {
  return MEDIA[extname(name).toLowerCase()];
}
