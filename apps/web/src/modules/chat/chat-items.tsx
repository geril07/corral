import type {
  ChatAnswer,
  ChatAssistantMessage,
  ChatError,
  ChatNotice,
  ChatReasoning,
  ChatToolCall,
  ChatUserMessage,
} from "@corral/protocol/chat";
import { useEffect, useState, type ReactNode } from "react";
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
  type IconName,
} from "../../common/ui/index.ts";
import { ChatRequestItem } from "./chat-request.tsx";
import { toolAction, toolLabel, type ChatRow, type ChatToolAction } from "./chat-rows.ts";
import { useMarkdownLinks } from "./local-links.tsx";

/** How long a copied message shows the check, as T3's copy state does (~1.2 s, no toast). */
const COPIED_MS = 1200;

/** The glyph of each action, from T3's `toolGroupSummaryIconName` (`TimelineWorkEntryRow.logic.ts:12`). */
const ACTION_ICON: Readonly<Record<ChatToolAction | "mixed", IconName>> = {
  read: "read",
  search: "find",
  edit: "edit",
  run: "terminal",
  other: "diagnostics",
  mixed: "hammer",
};

/**
 * One activity row: the icon slot, the label and the disclosure, in T3's work-row geometry
 * (`WorkLog.tsx:51`, `MessagesTimeline.tsx:1637`). A row without an icon is a turn-level row — the
 * fold's `Worked` — and starts at the lane's edge, as T3's turn fold does.
 */
function ActivityRow({
  icon,
  label,
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
        className={[
          "min-w-0 flex-1 truncate text-left",
          shimmer ? "shimmer" : "",
          live || shimmer ? "text-foreground" : "text-muted-foreground",
        ].join(" ")}
      >
        {label}
      </span>
      {running && <StatusGlyph state="working" />}
      {expanded !== undefined && <DisclosureIcon open={expanded} />}
    </>
  );
  if (onClick === undefined) {
    // The same recipe as the button below, so a row that cannot be clicked is not a second skin:
    // one kit change reaches both.
    return (
      <div className={buttonVariants({ variant: "ghost", layout: "activity", size: "activity" })}>
        {content}
      </div>
    );
  }
  return (
    <Button
      variant="ghost"
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

/**
 * The message's actions, under it and revealed by hover or keyboard focus but always tabbable
 * (`TimelineAssistantRows.tsx:170`: `opacity-0 ... focus-within:opacity-100 group-hover:opacity-100`).
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

/** The agent's answer, rendered as streaming Markdown by the kit's Streamdown wrapper. */
export function AssistantMessageItem({
  item,
  onFailure,
}: {
  item: ChatAssistantMessage;
  onFailure: (message: string) => void;
}) {
  // Local file paths and web links behave as the lane's `LocalLinks` resolved them; `docs/design.md`.
  const links = useMarkdownLinks();
  return (
    <div className="group/message flex flex-col gap-1">
      {/* A selection inside this message can be quoted into the composer (`SelectionAction`). */}
      <article aria-label="Agent message" data-selection-action>
        <Markdown text={item.text} streaming={item.streaming} links={links} />
      </article>
      {!item.streaming && (
        <div className="px-1">
          <MessageActions text={item.text} onFailure={onFailure} />
        </div>
      )}
    </div>
  );
}

/**
 * Reasoning is one muted row, collapsed by default. While it streams the row is T3's live
 * `Thinking`; when the turn moves on it is `Thought` (`TimelineWorkGroupRows.tsx:361`). A request
 * the agent waits on ends the live state, because nothing is being thought then
 * (`TimelineWorkGroupRows.tsx:366`). The contract carries no timestamps, so no duration is claimed.
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
        <p className="m-0 ms-7 text-sm whitespace-pre-wrap text-muted-foreground italic">
          {item.text}
        </p>
      )}
    </div>
  );
}

/**
 * One call: the action's glyph, its one-line label and its status, expandable in place. A failed
 * call keeps its action glyph in the error colour and says so in its accessible name, as T3 does
 * (`TimelineWorkGroupRows.tsx:449`).
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
  return (
    <div className="flex flex-col">
      <ActivityRow
        icon={ACTION_ICON[action]}
        label={label}
        expanded={expanded}
        live={running}
        failed={failed}
        running={running}
        // A command's own words already say `Running …`; every other action needs the state in its
        // name, because a running read, search or edit would otherwise read as finished.
        ariaLabel={
          failed
            ? `${label}, tool call failed`
            : running && action !== "run"
              ? `${label}, running`
              : label
        }
        onClick={onToggle}
      />
      {expanded && <ToolCallBody item={call} />}
    </div>
  );
}

function ToolCallBody({ item }: { item: ChatToolCall }) {
  const argumentsText = item.arguments.trim();
  const output = item.output?.trim() ?? "";
  return (
    <div className="flex flex-col gap-2 ms-7">
      {argumentsText !== "" && (
        <pre className="m-0 max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap">
          {argumentsText}
        </pre>
      )}
      {item.diff !== null ? (
        <DiffView text={item.diff.text} path={item.diff.path} />
      ) : (
        output !== "" && (
          <pre className="m-0 max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap">
            {output}
          </pre>
        )
      )}
    </div>
  );
}

/**
 * A run of finished calls folds into one verb summary — `Read 4 files and ran 2 commands` — until
 * expanded (`presentation.ts:532`, `TimelineWorkGroupRows.tsx:583`). Its entries are listed without
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
    <div className="flex flex-col">
      <ActivityRow
        icon={ACTION_ICON[action]}
        label={label}
        expanded={expanded}
        failed={failed}
        ariaLabel={failed ? `${label}, tool call failed` : label}
        onClick={onToggle}
      />
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
    </div>
  );
}

/**
 * A finished turn folds to one line: T3's `Worked` is the label it uses when the contract carries
 * no timestamps (`MessagesTimeline.logic.ts:1181`). What it hides is the projection's answer
 * (`chat-rows.ts`, `hiddenKeys`): the turn's work and its intermediate messages, while the turn's
 * terminal message stays in place below the fold.
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
    <div className="flex flex-col">
      <div className="border-b border-border/60">
        <ActivityRow label="Worked" expanded={expanded} onClick={onToggle} />
      </div>
      {children}
    </div>
  );
}

/** The live tail of a running turn: OpenCode's `Working` with its shimmer (`en.ts:656`). */
export function WorkingItem() {
  return (
    <div className="border-b border-border/60">
      <ActivityRow label="Working" live shimmer />
    </div>
  );
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
    <p className="m-0 text-sm text-destructive" role="alert">
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
      return <AssistantMessageItem item={item} onFailure={onFailure} />;
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
