import { useState } from "react";
import { Button } from "./button.tsx";
import { Dialog, DialogContent, DialogTitle } from "./dialog.tsx";

export interface MediaSource {
  kind: "image" | "video";
  /** A `blob:` URL of the file's bytes, held by the caller. */
  src: string;
  /** The file's name, for the alt text, the row and the lightbox title. */
  name: string;
}

/**
 * An image or video previewed in the message lane (`docs/ux.md`, **Local links in chat**). It is a
 * button, not a bare element: Enter or Space opens the lightbox, and the media itself is not
 * interactive, so the keyboard flow stays one stop.
 */
export function MediaPreview({ media }: { media: MediaSource }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        className="h-auto max-w-full p-0 hover:bg-transparent"
        aria-label={`Preview ${media.name}`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <MediaElement media={media} size="inline" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] sm:max-w-[calc(100%-4rem)]">
          <DialogTitle className="truncate">{media.name}</DialogTitle>
          <div className="flex max-h-[80vh] justify-center overflow-auto">
            <MediaElement media={media} size="lightbox" />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function MediaElement({ media, size }: { media: MediaSource; size: "inline" | "lightbox" }) {
  const className =
    size === "inline"
      ? "max-h-64 max-w-full rounded-md border border-border object-contain"
      : "max-h-[75vh] max-w-full rounded-md object-contain";
  if (media.kind === "image") {
    return <img className={className} src={media.src} alt={media.name} />;
  }
  return (
    <video
      className={className}
      src={media.src}
      // Inline, the frame is a preview and the lightbox is where it plays.
      controls={size === "lightbox"}
      muted
      playsInline
      preload="metadata"
      aria-label={media.name}
    />
  );
}
