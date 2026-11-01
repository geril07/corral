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
  ActionLink,
  Button,
  Icon,
  LinkAnchor,
  MediaPreview,
  type MarkdownLinks,
} from "../../common/ui/index.ts";
import {
  candidateBatches,
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
  /** Paths already asked about, whether they resolved or not: one ask per path, not per delta. */
  const requested = useRef(new Set<string>());
  /** Paths in a call that has not settled yet, so a streaming delta cannot ask twice. */
  const inFlight = useRef(new Set<string>());
  /** False once the lane closes; a late answer must not set state on a gone component. */
  const mounted = useRef(true);
  const objectUrls = useRef(new Map<string, string>());
  const candidates = useMemo(() => texts.flatMap((text) => pathCandidates(text)), [texts]);

  useEffect(() => {
    const pending = [...new Set(candidates)].filter(
      (path) => !requested.current.has(path) && !inFlight.current.has(path),
    );
    if (pending.length === 0) return;
    for (const path of pending) inFlight.current.add(path);
    Promise.all(candidateBatches(pending).map((batch) => files.resolve(batch)))
      .then((pages) => {
        const found = pages
          .flat()
          .flatMap((result) =>
            result.status === "ok" && result.target.kind === "file" ? [result.target] : [],
          );
        if (!mounted.current || found.length === 0) return;
        setKnown((current) => {
          const next = new Map(current);
          for (const file of found) next.set(file.requested, file);
          return next;
        });
      })
      // A refused lookup leaves the text plain. The paths count as asked either way, so a message
      // that keeps streaming does not retry the same batch on every delta.
      .catch(() => undefined)
      .finally(() => {
        for (const path of pending) {
          inFlight.current.delete(path);
          requested.current.add(path);
        }
      });
  }, [candidates, files]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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
    // An action, not a URL: no `href`, so a modifier click or "copy link" cannot promise one.
    return (
      <ActionLink title={file.path} onActivate={() => links.open(target)}>
        {children}
      </ActionLink>
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
 * `blob:` URL. Every way this can fail — past the bound, a refused read, bytes that do not decode
 * — ends as **one row with the editor**, never a broken frame or a stuck "Loading" line
 * (`docs/ux.md`, **Local links in chat**).
 */
function FileMedia({ file, target }: { file: FileTarget; target: LocalTarget }) {
  const links = useLocalLinks();
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);
  const loadable = file.previewable && file.media !== null;

  useEffect(() => {
    if (!loadable || links === undefined) return undefined;
    let live = true;
    links
      .media(file.path)
      .then((url) => {
        if (live) setSrc(url);
      })
      // A refused read is this row's problem, not the lane's: the row keeps its Open button.
      .catch(() => {
        if (live) setFailed(true);
      });
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
  if (failed) {
    return (
      <FileRow
        file={file}
        note={`Preview unavailable · ${formatBytes(file.size)}`}
        onOpen={() => links?.open(target)}
      />
    );
  }
  return (
    <span className="inline-flex w-full max-w-full flex-col gap-1">
      {src === undefined ? (
        // The max height a preview can take (`max-h-64`), held while the bytes travel: a row that
        // grows from 28 px to a screenshot's height would move everything the user is reading.
        <span
          className="flex min-h-64 w-full max-w-full items-center justify-center rounded-md border border-border bg-muted/20 text-xs text-muted-foreground"
          role="status"
        >
          Loading preview… · {formatBytes(file.size)}
        </span>
      ) : (
        <MediaPreview
          media={{ kind: file.media, src, name: file.name }}
          onError={() => setFailed(true)}
        />
      )}
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
      <Button
        variant="ghost"
        size="xs"
        aria-label={`Open ${file.path} in the editor`}
        onClick={onOpen}
      >
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
