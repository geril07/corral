import type {
  ChatAnswer,
  ChatAssistantMessage,
  ChatError,
  ChatNotice,
  ChatReasoning,
  ChatToolCall,
  ChatUserMessage,
} from "@corral/protocol/chat";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { describeError } from "@corral/client/rpc-errors";
import {
  Button,
  DiffView,
  DisclosureIcon,
  Icon,
  IconButton,
  Markdown,
  StatusGlyph,
  buttonVariants,
  useTruncatedText,
  type IconName,
} from "../../common/ui/index.ts";
import { ChatRequestItem } from "./chat-request.tsx";
import {
  toolAction,
  toolCommand,
  toolLabel,
  toolWrite,
  type ChatRow,
  type ChatToolAction,
} from "./chat-rows.ts";
import { useMarkdownLinks } from "./local-links.tsx";

/** How long a copied message shows the check, as T3's copy state does (~1.2 s, no toast). */
const COPIED_MS = 1200;

/**
 * The glyph of each action, from T3's `toolGroupSummaryIconName` in
 * `TimelineWorkEntryRow.logic.ts`.
 */
const ACTION_ICON: Readonly<Record<ChatToolAction | "mixed", IconName>> = {
  read: "read",
  search: "find",
  edit: "edit",
  run: "terminal",
  other: "diagnostics",
  mixed: "hammer",
};

/**
 * One activity row: the icon slot, the label and the disclosure. The row sizes to its content so
 * the disclosure sits beside the label (OpenCode's `BasicTool` trigger), inside T3's icon slot and
 * row height (`WorkLog.tsx`). A row without an icon is a turn-level row — the fold's `Worked`.
 */
function ActivityRow({
  icon,
  label,
  labelRef,
  expanded,
  live = false,
  failed = false,
  running = false,
  shimmer = false,
  ariaLabel,
  onClick,
}: {
  icon?: IconName | undefined;
  label: string;
  /** Measures the label, so a row can tell whether its text was cut off (see `ToolCallItem`). */
  labelRef?: Ref<HTMLSpanElement> | undefined;
  expanded?: boolean | undefined;
  live?: boolean;
  failed?: boolean;
  /** A call still running: the row keeps a status glyph, not only a colour. */
  running?: boolean;
  shimmer?: boolean;
  ariaLabel?: string | undefined;
  onClick?: (() => void) | undefined;
}) {
  const content = (
    <>
      {icon !== undefined && (
        <span
          className={[
            "flex w-6 shrink-0 items-center justify-center",
            failed ? "text-destructive" : live ? "text-foreground" : "text-muted-foreground",
          ].join(" ")}
        >
          <Icon name={icon} />
        </span>
      )}
      <span
        ref={labelRef}
        className={[
          "min-w-0 truncate text-left",
          shimmer ? "shimmer" : "",
          live || shimmer ? "text-foreground" : "text-muted-foreground",
        ].join(" ")}
      >
        {label}
      </span>
      {running && <StatusGlyph state="working" />}
      {expanded !== undefined && (
        <span
          className={[
            "flex w-3 shrink-0 items-center transition-opacity duration-200 motion-reduce:transition-none",
            expanded
              ? "opacity-100"
              : "opacity-0 group-hover/activity:opacity-100 group-focus-visible/activity:opacity-100",
          ].join(" ")}
        >
          <DisclosureIcon open={expanded} />
        </span>
      )}
    </>
  );
  if (onClick === undefined) {
    // The same recipe as the button below, so a row that cannot be clicked is not a second skin:
    // one kit change reaches both.
    return (
      <div
        className={buttonVariants({
          variant: "activity",
          layout: "activity",
          size: "activity",
        })}
      >
        {content}
      </div>
    );
  }
  return (
    <Button
      variant="activity"
      layout="activity"
      size="activity"
      aria-label={ariaLabel}
      aria-expanded={expanded}
      onClick={onClick}
    >
      {content}
    </Button>
  );
}

/** A shallower pinned header paints over the ones it holds: turn fold, then group, then call. */
const STACK_Z = ["z-30", "z-20", "z-10"] as const;

function stackZ(depth: number): string {
  return STACK_Z[depth] ?? "z-10";
}

/**
 * Where a pinned header sits and how deep it is in the stack. A nested header pins below its
 * parent, and the outermost paints over the ones it holds: an outgoing call's header must slide
 * under the group's header, not over it.
 */
const StickyStackContext = createContext<{ top: number; depth: number }>({ top: 0, depth: 0 });

/**
 * A row whose header pins to the top of the transcript while its own body scrolls past, so a long
 * call or a run of calls keeps its name in view; OpenCode pins a tool group's trigger the same way
 * (`message-part.css`, `[data-component="collapsed-tool-group"]`). An open group pushes the rows
 * inside it below its own header, as OpenCode's `--sticky-accordion-top` stack does. Only an open
 * section pins: a closed row is one line with nothing to scroll under it.
 */
function StickySection({
  open,
  header,
  children,
}: {
  open: boolean;
  header: ReactNode;
  children: ReactNode;
}) {
  const stack = useContext(StickyStackContext);
  const headerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  useLayoutEffect(() => {
    const node = headerRef.current;
    if (node === null) return undefined;
    const measure = () => setHeight(node.offsetHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  // The offset is measured rather than named as a length token: the row's height comes from its
  // type and padding, and a copy of those values would drift on the next recipe change.
  useLayoutEffect(() => {
    const node = headerRef.current;
    if (node === null || !open) return undefined;
    node.style.top = `${stack.top}px`;
    return () => {
      node.style.top = "";
    };
  }, [open, stack.top]);
  const nested = useMemo(
    () => ({ top: stack.top + height, depth: stack.depth + 1 }),
    [stack.top, stack.depth, height],
  );
  return (
    <div className="flex flex-col">
      <div ref={headerRef} className={open ? `sticky bg-canvas ${stackZ(stack.depth)}` : undefined}>
        {header}
      </div>
      <StickyStackContext.Provider value={nested}>{children}</StickyStackContext.Provider>
    </div>
  );
}

/**
 * The message's actions, under it and revealed by hover or keyboard focus but always tabbable
 * (`TimelineAssistantRows.tsx`: `opacity-0 ... focus-within:opacity-100 group-hover:opacity-100`).
 * Copy is T3's `MessageCopyButton`: raw text, the icon turns into a check, no toast.
 */
function MessageActions({
  text,
  onFailure,
}: {
  text: string;
  onFailure: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="flex items-center gap-1 opacity-0 transition-opacity duration-200 group-hover/message:opacity-100 focus-within:opacity-100 motion-reduce:transition-none">
      <IconButton
        label="Copy message"
        icon={copied ? "status-done" : "copy"}
        size="icon-xs"
        variant="ghost"
        layout="message"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(
            () => setCopied(true),
            // A refused clipboard is a sentence above the composer, as a refused send is.
            (error: unknown) => onFailure(describeError(error)),
          );
        }}
      />
    </div>
  );
}

/** User text is what the user typed; it is not Markdown and keeps its line breaks. */
export function UserMessageItem({
  item,
  onFailure,
}: {
  item: ChatUserMessage;
  onFailure: (message: string) => void;
}) {
  return (
    <div className="group/message flex flex-col items-end gap-1">
      <article
        aria-label="Your message"
        className="max-w-xl rounded-xl bg-layer-01 px-3 py-2 text-sm whitespace-pre-wrap"
      >
        {item.text}
      </article>
      <div className="pe-1">
        <MessageActions text={item.text} onFailure={onFailure} />
      </div>
    </div>
  );
}

/**
 * The agent's message, rendered as streaming Markdown by the kit's Streamdown wrapper. A turn's
 * answer sits at the turn's own edge, where its `Worked` header is, and carries the actions row;
 * the commentary inside the fold stays in the work column, beside the rows it narrates. Only the
 * answer takes the actions row: it reserves height, and one under every message would open a gap
 * in the middle of a turn's work.
 */
export function AssistantMessageItem({
  item,
  answer,
  onFailure,
}: {
  item: ChatAssistantMessage;
  answer: boolean;
  onFailure: (message: string) => void;
}) {
  const links = useMarkdownLinks();
  return (
    <div
      className={["group/message flex flex-col gap-1 py-1", answer ? "ps-0.5" : "ms-8"].join(" ")}
    >
      {/* A selection inside this message can be quoted into the composer (`SelectionAction`). */}
      <article aria-label="Agent message" data-selection-action>
        <Markdown text={item.text} streaming={item.streaming} links={links} />
      </article>
      {answer && !item.streaming && (
        <div className="px-1">
          <MessageActions text={item.text} onFailure={onFailure} />
        </div>
      )}
    </div>
  );
}

/**
 * Reasoning is one muted row, collapsed by default. While it streams the row is T3's live
 * `Thinking`; when the turn moves on it is `Thought` (`TimelineWorkGroupRows.tsx`). A request
 * the agent waits on ends the live state, because nothing is being thought then
 * (`TimelineWorkGroupRows.tsx`). The contract carries no timestamps, so no duration is claimed.
 */
export function ReasoningItem({
  item,
  expanded,
  onToggle,
  waiting,
}: {
  item: ChatReasoning;
  expanded: boolean;
  onToggle: () => void;
  /** The agent is blocked on the user, so a stream that is still open is not work in progress. */
  waiting: boolean;
}) {
  const live = item.streaming && !waiting;
  return (
    <div className="flex flex-col">
      <ActivityRow
        icon="thinking"
        label={live ? "Thinking" : "Thought"}
        expanded={expanded}
        live={live}
        shimmer={live}
        onClick={onToggle}
      />
      {expanded && (
        <p className="m-0 ms-8 my-1 text-sm whitespace-pre-wrap text-muted-foreground italic">
          {item.text}
        </p>
      )}
    </div>
  );
}

/**
 * One call: the action's glyph, its one-line label and its status, expandable in place. A failed
 * call keeps its action glyph in the error colour and says so in its accessible name, as T3 does
 * (`TimelineWorkGroupRows.tsx`).
 */
export function ToolCallItem({
  call,
  label,
  action,
  expanded,
  onToggle,
}: {
  call: ChatToolCall;
  /** The projection's words for this call, computed once where the row is built. */
  label: string;
  action: ChatToolAction;
  expanded: boolean;
  onToggle: () => void;
}) {
  const failed = call.status === "error";
  const running = call.status === "running";
  // A running command's label is only the program name, and a long one truncates; either way the
  // row cannot carry the command, so the body repeats it in full.
  const { observe: observeLabel, clipped } = useTruncatedText(label);
  return (
    <StickySection
      open={expanded}
      header={
        <ActivityRow
          icon={ACTION_ICON[action]}
          label={label}
          labelRef={observeLabel}
          expanded={expanded}
          live={running}
          failed={failed}
          running={running}
          // A command's own words already say `Running …`; every other action needs the state in
          // its name, because a running read, search or edit would otherwise read as finished.
          ariaLabel={
            failed
              ? `${label}, tool call failed`
              : running && action !== "run"
                ? `${label}, running`
                : label
          }
          onClick={onToggle}
        />
      }
    >
      {expanded && <ToolCallBody item={call} action={action} showCommand={clipped || running} />}
    </StickySection>
  );
}

const CARD_TEXT_CLASS = "m-0 max-h-64 overflow-auto p-2 font-mono text-xs whitespace-pre-wrap";

/**
 * One expanded body, drawn as a card: a header bar that names its subject — the command, the file —
 * and the result under it. OpenCode reads a tool the same way (`ConsoleOutput` repeats the command,
 * `FileTool` heads a change with its path), so a run, a diff, a whole-file write and a plain result
 * are one kind of block instead of four inventions.
 */
function ToolCard({
  title,
  failed,
  children,
}: {
  /** What the body is about; a body the row's label already names has none. */
  title?: string | undefined;
  failed: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={[
        "overflow-hidden rounded-md border",
        failed ? "border-destructive/50 bg-destructive/5" : "border-border bg-muted/40",
      ].join(" ")}
    >
      {title !== undefined && (
        <p
          className={[
            "m-0 border-b px-2 py-1.5 font-mono text-xs break-words whitespace-pre-wrap",
            failed ? "border-destructive/40 text-destructive" : "border-border/60 text-foreground",
          ].join(" ")}
        >
          {title}
        </p>
      )}
      {children}
    </div>
  );
}

/**
 * A block of text inside a card. `content` is what the call fed in — arguments or a whole file —
 * and reads in the foreground colour; `result` is what came back, kept quiet; `error` is a
 * failure's own words. `divided` separates it from the block above with the card's hairline.
 */
function CardText({
  text,
  tone,
  divided = false,
}: {
  text: string;
  tone: "content" | "result" | "error";
  divided?: boolean;
}) {
  return (
    <pre
      className={[
        CARD_TEXT_CLASS,
        tone === "content"
          ? "text-foreground"
          : tone === "result"
            ? "text-muted-foreground"
            : "text-destructive",
        divided
          ? tone === "error"
            ? "border-t border-destructive/40"
            : "border-t border-border/60"
          : "",
      ].join(" ")}
    >
      {text}
    </pre>
  );
}

/**
 * What the call returned, rendered by what it did rather than by the driver's name. A card's header
 * carries what the row's label cannot: the whole command when the row truncates it or the call is
 * still running, the file a change or a write touched. A read or a search names its path or query
 * in the row itself, so its card is the result alone, and an unclassified call has its arguments
 * as the body because nothing else describes it.
 */
function ToolCallBody({
  item,
  action,
  showCommand,
}: {
  item: ChatToolCall;
  action: ChatToolAction;
  showCommand: boolean;
}) {
  const output = item.output?.trim() ?? "";
  const failed = item.status === "error";
  const bodyClass = "ms-8 my-1 flex flex-col gap-2";
  if (action === "run") {
    const command = showCommand ? toolCommand(item) : undefined;
    if (command === undefined && output === "") return null;
    return (
      <div className={bodyClass}>
        <ToolCard title={command} failed={failed}>
          {output !== "" && <CardText text={output} tone={failed ? "error" : "result"} />}
        </ToolCard>
      </div>
    );
  }
  if (item.diff !== null) {
    return (
      <div className={bodyClass}>
        {/* The patch names each file it touched, so the card adds no header of its own. */}
        <ToolCard failed={failed}>
          <DiffView text={item.diff.text} />
          {failed && output !== "" && <CardText text={output} tone="error" divided />}
        </ToolCard>
      </div>
    );
  }
  // A write's arguments are the file's whole new text, so the card shows that under the path
  // instead of the JSON envelope around it. An edit that does not carry a whole file keeps its
  // arguments as text, as an unclassified call does.
  const write = action === "edit" ? toolWrite(item) : undefined;
  const text =
    write?.text ?? (action === "edit" || action === "other" ? item.arguments.trim() : "");
  if (text === "" && output === "") return null;
  return (
    <div className={bodyClass}>
      <ToolCard title={write?.path} failed={failed}>
        {text !== "" && <CardText text={text} tone="content" />}
        {output !== "" && (
          <CardText text={output} tone={failed ? "error" : "result"} divided={text !== ""} />
        )}
      </ToolCard>
    </div>
  );
}

/**
 * A run of finished calls folds into one verb summary — `Read 4 files and ran 2 commands` — until
 * expanded (`presentation.ts`, `TimelineWorkGroupRows.tsx`). Its entries are listed without
 * a second indent: they are the group's own rows, not a body under one of them.
 */
export function ToolGroupItem({
  items,
  label,
  action,
  failed,
  expanded,
  onToggle,
  expandedFolds,
  onToggleFold,
}: {
  items: readonly ChatToolCall[];
  /** The projection's summary of the run, computed once where the row is built. */
  label: string;
  action: ChatToolAction | "mixed";
  failed: boolean;
  expanded: boolean;
  onToggle: () => void;
  expandedFolds: ReadonlySet<string>;
  onToggleFold: (key: string) => void;
}) {
  return (
    <StickySection
      open={expanded}
      header={
        <ActivityRow
          icon={ACTION_ICON[action]}
          label={label}
          expanded={expanded}
          failed={failed}
          ariaLabel={failed ? `${label}, tool call failed` : label}
          onClick={onToggle}
        />
      }
    >
      {expanded &&
        items.map((item) => (
          <ToolCallItem
            key={item.id}
            call={item}
            label={toolLabel(item)}
            action={toolAction(item)}
            expanded={expandedFolds.has(item.id)}
            onToggle={() => onToggleFold(item.id)}
          />
        ))}
    </StickySection>
  );
}

/**
 * A finished turn folds to one line: T3's `Worked` is the label it uses when the contract carries
 * no timestamps (`MessagesTimeline.logic.ts`). What it hides is the projection's answer
 * (`chat-rows.ts`, `hiddenKeys`): the turn's work and its intermediate messages. The turn's answer
 * is the row after this one, so a pinned header never holds over text that is not work.
 */
export function TurnFoldItem({
  expanded,
  onToggle,
  children,
}: {
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <StickySection
      open={expanded}
      header={<ActivityRow label="Worked" expanded={expanded} onClick={onToggle} />}
    >
      {children}
    </StickySection>
  );
}

/** The live tail of a running turn: OpenCode's `Working` with its shimmer. */
export function WorkingItem() {
  return <ActivityRow label="Working" live shimmer />;
}

/** A quiet line for a compaction, a retry or another note from the agent or driver. */
export function NoticeItem({ item }: { item: ChatNotice }) {
  return (
    <p className="m-0 py-1 text-center text-xs text-muted-foreground" role="note">
      {item.text}
    </p>
  );
}

export function ErrorItem({ item }: { item: ChatError }) {
  return (
    <p className="m-0 ps-0.5 py-1 text-sm text-destructive" role="alert">
      {item.text}
    </p>
  );
}

export interface TranscriptRowProps {
  row: ChatRow;
  /** The folds the user opened, keyed by turn or group id. */
  expanded: ReadonlySet<string>;
  onToggleFold: (key: string) => void;
  onRespond: (requestId: string, value: ChatAnswer) => Promise<void>;
  onAnswered: (requestId: string) => void;
  /** A message action that failed says so in the pane's one failure line. */
  onFailure: (message: string) => void;
  /** The agent is blocked on the user, so a streaming reasoning row is not live work. */
  waiting: boolean;
  focusedRequest?: string | undefined;
  /**
   * The assistant messages that show their actions row: a turn's answer, not its commentary
   * (`terminalAssistantIds`). Absent, no message shows one.
   */
  actionsFor?: ReadonlySet<string> | undefined;
}

/**
 * One projected row. A turn fold and a tool group both recurse through here, so a fold's contents
 * are the same rows the timeline would have shown.
 */
export function TranscriptRow({
  row,
  expanded,
  onToggleFold,
  onRespond,
  onAnswered,
  onFailure,
  waiting,
  focusedRequest,
  actionsFor,
}: TranscriptRowProps) {
  if (row.kind === "working") return <WorkingItem />;
  if (row.kind === "turn") {
    const open = expanded.has(row.key);
    return (
      <TurnFoldItem expanded={open} onToggle={() => onToggleFold(row.key)}>
        {row.rows.map((inner) =>
          // Closed, the fold hides what the projection named; everything else keeps its place.
          open || !row.hidden.has(inner.key) ? (
            <TranscriptRow
              key={inner.key}
              row={inner}
              expanded={expanded}
              onToggleFold={onToggleFold}
              onRespond={onRespond}
              onAnswered={onAnswered}
              onFailure={onFailure}
              waiting={waiting}
              focusedRequest={focusedRequest}
              actionsFor={actionsFor}
            />
          ) : null,
        )}
      </TurnFoldItem>
    );
  }
  if (row.kind === "group") {
    return (
      <ToolGroupItem
        items={row.items}
        label={row.label}
        action={row.action}
        failed={row.failed}
        expanded={expanded.has(row.key)}
        onToggle={() => onToggleFold(row.key)}
        expandedFolds={expanded}
        onToggleFold={onToggleFold}
      />
    );
  }
  if (row.kind === "tool") {
    return (
      <ToolCallItem
        call={row.call}
        label={row.label}
        action={row.action}
        expanded={expanded.has(row.key)}
        onToggle={() => onToggleFold(row.key)}
      />
    );
  }
  const { item } = row;
  switch (item.kind) {
    case "user-message":
      return <UserMessageItem item={item} onFailure={onFailure} />;
    case "assistant-message":
      return (
        <AssistantMessageItem
          item={item}
          answer={actionsFor?.has(item.id) === true}
          onFailure={onFailure}
        />
      );
    case "reasoning":
      return (
        <ReasoningItem
          item={item}
          expanded={expanded.has(item.id)}
          onToggle={() => onToggleFold(item.id)}
          waiting={waiting}
        />
      );
    case "tool-call":
      return (
        <ToolCallItem
          call={item}
          label={toolLabel(item)}
          action={toolAction(item)}
          expanded={expanded.has(item.id)}
          onToggle={() => onToggleFold(item.id)}
        />
      );
    case "user-request":
      return (
        <ChatRequestItem
          item={item}
          onRespond={(value) => onRespond(item.id, value)}
          onAnswered={() => onAnswered(item.id)}
          selected={item.id === focusedRequest}
        />
      );
    case "notice":
      return <NoticeItem item={item} />;
    case "error":
      return <ErrorItem item={item} />;
    default:
      return null;
  }
}
