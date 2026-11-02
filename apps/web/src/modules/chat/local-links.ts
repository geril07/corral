/**
 * Local links in chat: which runs of an agent's text are a web URL or a workspace path, and the
 * link URL a resolved path becomes. Everything here is a pure function of the text, so a streamed
 * message can be re-scanned on every delta without state: the same final text always yields the
 * same links, whatever the chunk boundaries were (`docs/plans/stage-c.md`, C5).
 *
 * Detection is deliberately permissive and resolution decides: `src/foo` is offered as a candidate
 * and `files.resolve` answers `missing`, so it stays plain text. A renderer never shows a link the
 * workspace does not hold.
 */
import { FILE_PATH_MAX, FILE_RESOLVE_BATCH } from "@corral/protocol/rpc";

/** The file (and position) a path-like token names: `src/app.ts:12:3` → `src/app.ts`, line 12, col 3. */
export interface LocalTarget {
  /** As written, without the `:line[:col]` suffix. */
  path: string;
  line?: number;
  column?: number;
}

export interface DetectedLink {
  /** Index of the first character in the text. */
  start: number;
  /** Index one past the last character. */
  end: number;
  /** The text exactly as it appears, suffix included. */
  raw: string;
  kind: "url" | "path";
  /** A path token's target; absent for a URL. */
  target?: LocalTarget;
}

/** Characters a path token may hold. `:` is out on purpose: it starts the position suffix. */
const PATH_CHARS = /[A-Za-z0-9._/@+-]+/g;
/** A URL stops at whitespace and at the delimiters Markdown and prose use around it. */
const URL_CHARS = /https?:\/\/[^\s<>"'`]+/g;
/** Punctuation prose puts right after a token; never part of it. */
const TRAILING = /[.,;!?)\]}"'»]+$/;
/** Trailing path characters that are punctuation or a dangling separator, not a name. */
const TRAILING_PATH = /[./]+$/;
/** A single file name with an extension, e.g. `README.md`. */
const FILE_NAME = /^[A-Za-z0-9_+-]+(?:\.[A-Za-z0-9_+-]+)+$/;

/** The `:line[:col]` suffix of a path token, only when the digits end a token. */
const POSITION = /^:(\d{1,7})(?::(\d{1,7}))?(?![A-Za-z0-9_])/;
/** The same suffix at the end of a whole URL or token. */
const POSITION_SUFFIX = /:(\d{1,7})(?::(\d{1,7}))?$/;
/** A URL scheme (`https:`, `mailto:`, `javascript:`, and a Windows drive like `C:`). */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Splits a path token's `:line[:col]` suffix: `src/a.ts:12:3` → path `src/a.ts`, line 12, col 3. */
function splitPosition(raw: string): LocalTarget {
  const match = POSITION_SUFFIX.exec(raw);
  if (match === null) return { path: raw };
  const target: LocalTarget = { path: raw.slice(0, match.index), line: Number(match[1]) };
  if (match[2] !== undefined) target.column = Number(match[2]);
  return target;
}

export function detectLinks(text: string): DetectedLink[] {
  const links: DetectedLink[] = [];
  const blocked: Array<readonly [number, number]> = [];
  for (const match of text.matchAll(URL_CHARS)) {
    const start = match.index ?? 0;
    const raw = match[0].replace(TRAILING, "");
    if (raw === "") continue;
    // `https://` alone is not a link; a host (or at least one more character) is.
    if (raw.replace(/^https?:\/\//, "").length === 0) continue;
    const end = start + raw.length;
    links.push({ start, end, raw, kind: "url" });
    blocked.push([start, end]);
  }
  for (const match of text.matchAll(PATH_CHARS)) {
    const start = match.index ?? 0;
    let raw = match[0];
    if (isBlocked(blocked, start)) continue;
    raw = raw.replace(TRAILING_PATH, "");
    if (!plausiblePath(raw)) continue;
    const position = POSITION.exec(text.slice(start + raw.length));
    let end = start + raw.length;
    if (position !== null) end += position[0].length;
    const token = text.slice(start, end);
    links.push({ start, end, raw: token, kind: "path", target: splitPosition(token) });
  }
  return links.toSorted((left, right) => left.start - right.start);
}

function isBlocked(blocked: Array<readonly [number, number]>, index: number): boolean {
  return blocked.some(([start, end]) => index >= start && index < end);
}

/** Absolute, a directory-qualified relative path, or a single name with an extension. */
function plausiblePath(raw: string): boolean {
  if (raw === "" || raw === "." || raw === "..") return false;
  if (raw.includes("//")) return false;
  if (raw.startsWith("/")) return raw.length > 1;
  if (raw.includes("/")) return !raw.startsWith("/");
  return FILE_NAME.test(raw);
}

/**
 * The file an explicit Markdown link's destination names — `[label](/etc/passwd)`,
 * `[label](src/a.ts:12)` — or `undefined` when the destination is not a path this lane can own.
 * A scheme, a protocol-relative URL, an in-page anchor (`#/route`) and whitespace are not paths, so
 * they are never rewritten into a file token (`docs/ux.md`, **Local links in chat**).
 */
export function pathTargetOf(url: string): LocalTarget | undefined {
  const value = url.trim();
  if (value === "" || value.startsWith("#") || value.startsWith("//")) return undefined;
  if (SCHEME.test(value) || /\s/.test(value)) return undefined;
  const target = splitPosition(value);
  return plausiblePath(target.path) ? target : undefined;
}

/** `[label](destination)` in running text. */
const LINK_DESTINATION = /\]\(\s*<?([^)\s>]+)>?/g;
/** A reference definition line: `[ref]: destination`. */
const LINK_DEFINITION = /^[ \t]{0,3}\[[^\]]+\]:[ \t]*(\S+)/gm;

/**
 * The paths the explicit Markdown links of a text name. The lane resolves candidates from the
 * message's text as well as from its link destinations, so `[the file](src/app.ts:12)` becomes a
 * target exactly like the bare token would. A false candidate costs one lookup; the tree transform
 * is what decides whether a link renders, so this scan does not need to be a Markdown parser.
 */
export function linkTargetCandidates(text: string): string[] {
  const paths = new Set<string>();
  for (const expression of [LINK_DESTINATION, LINK_DEFINITION]) {
    for (const match of text.matchAll(expression)) {
      const destination = match[1];
      if (destination === undefined) continue;
      const target = pathTargetOf(destination);
      if (target !== undefined && target.path.length <= FILE_PATH_MAX) paths.add(target.path);
    }
  }
  return [...paths];
}

/**
 * The candidates in as many calls as `files.resolve` accepts, first-seen order kept. A lane asks
 * about every path its transcript names, which is more than one call may carry in a long chat.
 */
export function candidateBatches(paths: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (let start = 0; start < paths.length; start += FILE_RESOLVE_BATCH) {
    batches.push(paths.slice(start, start + FILE_RESOLVE_BATCH));
  }
  return batches;
}

/**
 * Every distinct path a text offers, in first-seen order: the batch `files.resolve` takes. A token
 * past `FILE_PATH_MAX` is not a candidate — the wire schema would refuse the whole call for it.
 */
export function pathCandidates(text: string): string[] {
  const seen = new Set<string>();
  for (const link of detectLinks(text)) {
    if (link.kind !== "path" || link.target === undefined) continue;
    if (link.target.path.length > FILE_PATH_MAX) continue;
    seen.add(link.target.path);
  }
  return [...seen];
}

/**
 * `#corral-file?path=…&line=…`: the token the remark transform puts on a link node so the anchor
 * knows which file it means. It is internal — the anchor never renders it as an `href`, because a
 * link that runs the editor is an action, not a URL (`docs/ux.md`, **Local links in chat**).
 */
export function fileLinkHref(target: LocalTarget): string {
  const params = new URLSearchParams({ path: target.path });
  if (target.line !== undefined) params.set("line", String(target.line));
  if (target.column !== undefined) params.set("column", String(target.column));
  return `#corral-file?${params.toString()}`;
}

export function parseFileLinkHref(href: string): LocalTarget | undefined {
  if (!href.startsWith("#corral-file?")) return undefined;
  const params = new URLSearchParams(href.slice("#corral-file?".length));
  const path = params.get("path") ?? "";
  if (path === "") return undefined;
  const target: LocalTarget = { path };
  const line = positive(params.get("line"));
  if (line !== undefined) target.line = line;
  const column = positive(params.get("column"));
  if (column !== undefined) target.column = column;
  return target;
}

function positive(value: string | null): number | undefined {
  if (value === null) return undefined;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

/**
 * The Markdown tree this plugin walks: just enough of mdast to replace text nodes, so the module
 * needs no `@types/mdast` dependency for one walker.
 */
export interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  title?: string | null;
  children?: MarkdownNode[];
  /** A reference definition's label; `linkReference` nodes point at it by identifier. */
  identifier?: string;
  /** The root's reference definitions (`[ref]: destination`). */
  definitions?: MarkdownNode[];
  [key: string]: unknown;
}

/** Element types whose text is not prose: links (no nesting) and code (not a path to open). */
const NOT_PROSE = new Set(["link", "linkReference", "code", "inlineCode", "html", "image"]);

/**
 * Turns detected URLs and path-shaped text into link nodes, so a path an agent wrote can be
 * clicked without touching code spans or nesting a link inside a link. Resolution stays out of the
 * tree on purpose: the anchor (`local-links.tsx`) shows the editor link only for a path
 * `files.resolve` confirmed, so an unresolved candidate renders as the text it already was. That
 * keeps this transform a pure function of the text and stable across a streaming re-render.
 *
 * An **explicit** Markdown link whose destination is a path — `[label](/etc/passwd)`,
 * `[label](src/a.ts:12)`, `[label](./x)` — is rewritten to the same file token, keeping its label.
 * Otherwise the anchor would see a destination it does not own and the lane would render (or, in
 * the bug this fixes, follow) a link that points at the static server. Web and `mailto:` links are
 * left alone; reference definitions are rewritten the same way, because a `linkReference` resolves
 * its destination from them.
 */
export function localLinkPlugin(): (tree: MarkdownNode) => void {
  return localLinkTransform;
}

/** The tree transform itself: everything the plugin does, as a plain function of the tree. */
export function localLinkTransform(tree: MarkdownNode): void {
  for (const definition of tree.definitions ?? []) {
    rewriteDestination(definition);
  }
  linkifyChildren(tree);
}

/** A link node or reference definition whose destination is a workspace-shaped path. */
function rewriteDestination(node: MarkdownNode): void {
  if (node.type !== "link" && node.type !== "definition") return;
  const url = node.url;
  if (typeof url !== "string") return;
  const target = pathTargetOf(url);
  if (target !== undefined) node.url = fileLinkHref(target);
}

function linkifyChildren(parent: MarkdownNode): void {
  const children = parent.children;
  if (children === undefined) return;
  const next: MarkdownNode[] = [];
  for (const child of children) {
    if (child.type === "text" && typeof child.value === "string") {
      next.push(...linkifyText(child.value));
      continue;
    }
    // An explicit link's destination is the agent's own path, not prose: rewrite the link itself.
    if (child.type === "link") {
      rewriteDestination(child);
      next.push(child);
      continue;
    }
    if (!NOT_PROSE.has(child.type)) linkifyChildren(child);
    next.push(child);
  }
  parent.children = next;
}

function linkifyText(value: string): MarkdownNode[] {
  const links = detectLinks(value);
  if (links.length === 0) return [{ type: "text", value }];
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  const pushText = (end: number) => {
    if (end > cursor) nodes.push({ type: "text", value: value.slice(cursor, end) });
  };
  for (const link of links) {
    let url: string;
    if (link.kind === "url") {
      url = link.raw;
    } else {
      if (link.target === undefined) continue;
      url = fileLinkHref(link.target);
    }
    pushText(link.start);
    nodes.push({
      type: "link",
      url,
      title: null,
      children: [{ type: "text", value: link.raw }],
    });
    cursor = link.end;
  }
  pushText(value.length);
  return nodes;
}
