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
import { FILE_RESOLVE_BATCH } from "@corral/protocol/rpc";

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
    const target: LocalTarget = { path: raw };
    let end = start + raw.length;
    if (position !== null) {
      target.line = Number(position[1]);
      const column = position[2];
      if (column !== undefined) target.column = Number(column);
      end += position[0].length;
    }
    links.push({ start, end, raw: text.slice(start, end), kind: "path", target });
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

/** Every distinct path a text offers, in first-seen order: the batch `files.resolve` takes. */
export function pathCandidates(text: string): string[] {
  const seen = new Set<string>();
  for (const link of detectLinks(text)) {
    if (link.kind === "path" && link.target !== undefined) seen.add(link.target.path);
  }
  return [...seen];
}

/** `#corral-file?path=…&line=…`: a link URL that survives Markdown's URL transform untouched. */
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
 */
export function localLinkPlugin(): (tree: MarkdownNode) => void {
  return localLinkTransform;
}

/** The tree transform itself: everything the plugin does, as a plain function of the tree. */
export function localLinkTransform(tree: MarkdownNode): void {
  linkifyChildren(tree);
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
