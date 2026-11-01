import { Streamdown } from "streamdown";
// The stylesheet ships Streamdown's animation keyframes; the utility classes its DOM uses come
// from the `@source` lines in `app/global.css` (see `docs/ui-kit.md`).
// oxlint-disable-next-line import/no-unassigned-import -- the package's own keyframes
import "streamdown/styles.css";
import { pierreCodePlugin } from "./streamdown-code.ts";

const MARKDOWN_THEMES = ["pierre-light", "pierre-dark"] as const;

/**
 * Assistant Markdown (goal D1): Streamdown with its own UI off. `controls={false}` drops the
 * copy/download/table/fullscreen controls and `linkSafety` is off, so a link is a plain link
 * until stage C gives local files their own behavior. The component is wrapped here so the kit
 * gates cover the surface; modules pass text and whether it is still streaming, no classes.
 */
export function Markdown({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className="text-sm leading-relaxed">
      <Streamdown
        mode={streaming ? "streaming" : "static"}
        parseIncompleteMarkdown={streaming}
        animated={false}
        controls={false}
        linkSafety={{ enabled: false }}
        plugins={{ code: pierreCodePlugin }}
        shikiTheme={[MARKDOWN_THEMES[0], MARKDOWN_THEMES[1]]}
      >
        {text}
      </Streamdown>
    </div>
  );
}
