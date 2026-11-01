import { describeError } from "@corral/client/rpc-errors";
import { externalUrl } from "@corral/protocol/external-url";
import type { FileBytes, FileResolution, FileTarget } from "@corral/protocol/rpc";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Button,
  Icon,
  LinkAnchor,
  MediaPreview,
  type MarkdownLinks,
  type MediaSource,
} from "../../common/ui/index.ts";
import {
  localLinkPlugin,
  parseFileLinkHref,
  pathCandidates,
  type LocalTarget,
} from "./local-links.ts";

/**
 * What the chat lane may ask of the server for a local link (`files.*`): resolve candidates, read
 * a previewable file's bytes and open a file in the editor. The workspace builds it, so this module
 * stays free of the connection (as the B0 store does).
 */
export interface ChatFiles {
  resolve(paths: readonly string[]): Promise<FileResolution[]>;
  read(path: string): Promise<FileBytes>;
  open(path: string, line?: number, column?: number): Promise<void>;
}

interface LocalLinksState {
  known: ReadonlyMap<string, FileTarget>;
  /** Opens a file in the user's editor; a refusal becomes a visible line in the lane. */
  open(target: LocalTarget): void;
  /** A `blob:` URL of a previewable file's bytes, cached for the life of the lane. */
  media(path: string): Promise<string>;
  failure: string | undefined;
}

const LocalLinksContext = createContext<LocalLinksState | undefined>(undefined);

/**
 * Resolves and renders the workspace paths an agent's text names: candidates come from detection,
 * existence from the server (`files.resolve`), so a false positive such as `src/foo` stays text
 * instead of becoming a dead link. Resolution is once per new candidate, not per delta.
 */
export function LocalLinks({
  files,
  texts,
  children,
}: {
  files: ChatFiles;
  /** The Message texts currently rendered; only new candidates trigger a lookup. */
  texts: readonly string[];
  children: ReactNode;
}) {
  const [known, setKnown] = useState<ReadonlyMap<string, FileTarget>>(() => new Map());
  const [failure, setFailure] = useState<string>();
  const requested = useRef(new Set<string>());
  const objectUrls = useRef(new Map<string, string>());
  const candidates = useMemo(() => texts.flatMap((text) => pathCandidates(text)), [texts]);

  useEffect(() => {
    const missing = [...new Set(candidates)].filter((path) => !requested.current.has(path));
    if (missing.length === 0) return undefined;
    let live = true;
    files
      .resolve(missing)
      .then((results) => {
        if (!live) return;
        for (const path of missing) requested.current.add(path);
        const found = results.flatMap((result) =>
          result.status === "ok" && result.target.kind === "file" ? [result.target] : [],
        );
        if (found.length === 0) return;
        setKnown((current) => {
          const next = new Map(current);
          for (const file of found) next.set(file.requested, file);
          return next;
        });
      })
      // A lookup that fails leaves the text plain; the next message asks again.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [candidates, files]);

  // The object URLs belong to this lane; a closed chat view releases them.
  useEffect(() => {
    const urls = objectUrls.current;
    return () => {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const open = useCallback(
    (target: LocalTarget) => {
      setFailure(undefined);
      files.open(target.path, target.line, target.column).catch((error: unknown) => {
        setFailure(describeError(error));
      });
    },
    [files],
  );

  const media = useCallback(
    (path: string) => {
      const cached = objectUrls.current.get(path);
      if (cached !== undefined) return Promise.resolve(cached);
      return files.read(path).then((bytes) => {
        const url = URL.createObjectURL(
          new Blob([decodeBase64(bytes.bytes)], { type: bytes.mime }),
        );
        objectUrls.current.set(path, url);
        return url;
      });
    },
    [files],
  );

  const value = useMemo<LocalLinksState>(
    () => ({ known, open, media, failure }),
    [known, open, media, failure],
  );
  return <LocalLinksContext value={value}>{children}</LocalLinksContext>;
}

/** The lane's link state, or `undefined` outside a chat lane (Markdown then renders plain links). */
export function useLocalLinks(): LocalLinksState | undefined {
  return useContext(LocalLinksContext);
}

/** The refusal of an editor launch, where the composer's own errors appear (`docs/ux.md`). */
export function LocalLinkFailure() {
  const failure = useLocalLinks()?.failure;
  if (failure === undefined) return null;
  return (
    <p className="m-0 text-sm text-destructive" role="alert">
      {failure}
    </p>
  );
}

/**
 * The `remarkPlugins`/`components` pair the kit's Markdown takes for this lane. One constant: the
 * tree transform depends only on the text, and the anchor reads the resolved targets from context,
 * so a resolution that arrives late re-renders the link without re-parsing the Markdown.
 */
const MARKDOWN_LINKS: MarkdownLinks = {
  remarkPlugins: [localLinkPlugin],
  anchor: LocalLinkAnchor,
};

export function useMarkdownLinks(): MarkdownLinks {
  return MARKDOWN_LINKS;
}

/**
 * Every anchor the lane's Markdown renders. A local file link opens the editor with the position
 * the message named; media is previewed inline instead; an ordinary web link goes to the OS browser
 * in the desktop app and to a new tab in a browser, never into this window
 * (`docs/design.md`, **Local trust boundary**).
 */
function LocalLinkAnchor({ href, children }: { href?: string | undefined; children?: ReactNode }) {
  const links = useLocalLinks();
  const target = href === undefined ? undefined : parseFileLinkHref(href);
  if (target !== undefined) {
    const file = links?.known.get(target.path);
    if (links === undefined || file === undefined) return <>{children}</>;
    if (file.media !== null) return <FileMedia file={file} target={target} />;
    return (
      <LinkAnchor href={href ?? "#"} title={file.path} onActivate={() => links.open(target)}>
        {children}
      </LinkAnchor>
    );
  }
  const url = href === undefined ? undefined : externalUrl(href);
  if (url !== undefined) {
    return (
      <LinkAnchor href={url} onActivate={() => openWebLink(url)}>
        {children}
      </LinkAnchor>
    );
  }
  return href === undefined ? <>{children}</> : <LinkAnchor href={href}>{children}</LinkAnchor>;
}

/**
 * An ordinary web link leaves the capability-bearing window: the desktop shell hands it to the OS
 * browser, a plain browser opens a tab. The URL is re-checked here because detection is just text.
 */
export function openWebLink(url: string): void {
  const bridge = window.corral;
  if (bridge !== undefined) {
    void bridge.openExternal(url).catch(() => undefined);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * An image or video the message pointed at. Bytes come over RPC (`files.read`) and become a
 * `blob:` URL; too large or not previewable is one row with the editor link, never a broken frame.
 */
function FileMedia({ file, target }: { file: FileTarget; target: LocalTarget }) {
  const links = useLocalLinks();
  const [src, setSrc] = useState<string>();
  const loadable = file.previewable && file.media !== null;

  useEffect(() => {
    if (!loadable || links === undefined) return undefined;
    let live = true;
    links
      .media(file.path)
      .then((url) => {
        if (live) setSrc(url);
      })
      // A read refusal keeps the row with its reason; it is not a lane-wide failure.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [loadable, links, file.path]);

  if (file.media === null) return null;
  if (!loadable) {
    return (
      <FileRow
        file={file}
        note={`Too large to preview · ${formatBytes(file.size)}`}
        onOpen={() => links?.open(target)}
      />
    );
  }
  if (src === undefined) {
    return (
      <FileRow
        file={file}
        note={`Loading preview… · ${formatBytes(file.size)}`}
        onOpen={() => links?.open(target)}
      />
    );
  }
  const media: MediaSource = { kind: file.media, src, name: file.name };
  return (
    <span className="inline-flex max-w-full flex-col gap-1">
      <MediaPreview media={media} />
      <span className="text-xs text-muted-foreground">{file.path}</span>
    </span>
  );
}

/** One row for a file that is not previewed inline: name, size, the reason and the editor. */
function FileRow({ file, note, onOpen }: { file: FileTarget; note: string; onOpen: () => void }) {
  return (
    <span className="my-1 flex max-w-full items-center gap-2 rounded-md border border-border px-2 py-1 align-middle">
      <Icon name="task" size="row" />
      <span className="truncate font-mono text-xs" title={file.path}>
        {file.path}
      </span>
      <span className="truncate text-xs text-muted-foreground">{note}</span>
      <Button variant="ghost" size="xs" onClick={onOpen}>
        Open
      </Button>
    </span>
  );
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
