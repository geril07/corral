import { useMemo, type ComponentProps, type ComponentType, type ReactNode } from "react";
import { Streamdown } from "streamdown";
// The stylesheet ships Streamdown's animation keyframes; the utility classes its DOM uses come
// from the `@source` lines in `app/global.css` (see `docs/ui-kit.md`).
// oxlint-disable-next-line import/no-unassigned-import -- the package's own keyframes
import "streamdown/styles.css";
import { pierreCodePlugin } from "./streamdown-code.ts";

const MARKDOWN_THEMES = ["pierre-light", "pierre-dark"] as const;

type StreamdownOptions = ComponentProps<typeof Streamdown>;

type StreamdownComponents = NonNullable<StreamdownOptions["components"]>;

/** A link as the Markdown tree produced it: its URL and the text it was written as. */
export interface MarkdownAnchorProps {
  href?: string | undefined;
  children?: ReactNode;
}

/**
 * How a caller's links render. The module that owns a link's meaning (chat's local files and its
 * web links) supplies both halves: a remark plugin that turns plain text into link nodes, and the
 * component every anchor renders through, which decides what a click does and may replace the
 * whole anchor with a preview. The kit stays the only place that renders the elements.
 */
export interface MarkdownLinks {
  readonly remarkPlugins?: StreamdownOptions["remarkPlugins"];
  /** Absent keeps Streamdown's own anchor, which is a plain link. */
  readonly anchor?: ComponentType<MarkdownAnchorProps>;
}

/**
 * Streamdown's `components` map is keyed by tag but then re-checked against an index signature
 * typed `Record<string, unknown>`, which no component with real props satisfies. The kit is where
 * that surface is absorbed, so the assertion lives here and nowhere else.
 */
function anchorComponents(Anchor: ComponentType<MarkdownAnchorProps>): StreamdownComponents {
  const AnchorElement = (props: MarkdownAnchorProps) => (
    <Anchor href={props.href}>{props.children}</Anchor>
  );
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the map's index signature cannot describe a component with real props
  return { a: AnchorElement } as unknown as StreamdownComponents;
}

/**
 * Assistant Markdown (goal D1): Streamdown with its own UI off. `controls={false}` drops the
 * copy/download/table/fullscreen controls and `linkSafety` is off, so a link's behavior belongs to
 * `links` — without it a link is a plain anchor. The component is wrapped here so the kit gates
 * cover the surface; modules pass text, whether it is still streaming, and their link rendering,
 * no classes.
 */
export function Markdown({
  text,
  streaming,
  links,
}: {
  text: string;
  streaming: boolean;
  links?: MarkdownLinks;
}) {
  const anchor = links?.anchor;
  const components = useMemo(
    () => (anchor === undefined ? undefined : anchorComponents(anchor)),
    [anchor],
  );
  return (
    <div className="text-sm leading-relaxed">
      <Streamdown
        mode={streaming ? "streaming" : "static"}
        parseIncompleteMarkdown={streaming}
        animated={false}
        controls={false}
        linkSafety={{ enabled: false }}
        lineNumbers={false}
        codeBlockMaxHeight={400}
        tableMaxHeight={300}
        plugins={{ code: pierreCodePlugin }}
        shikiTheme={[MARKDOWN_THEMES[0], MARKDOWN_THEMES[1]]}
        {...(links?.remarkPlugins === undefined ? {} : { remarkPlugins: links.remarkPlugins })}
        {...(components === undefined ? {} : { components })}
      >
        {text}
      </Streamdown>
    </div>
  );
}
