import type {
  ChatAssistantMessage,
  ChatError,
  ChatNotice,
  ChatReasoning,
  ChatToolCall,
  ChatToolStatus,
  ChatUserMessage,
} from "@corral/protocol/chat";
import type { AgentState } from "@corral/protocol/rpc";
import { useEffect, useRef, useState } from "react";
import { Button, DiffView, Icon, Markdown, StatusGlyph } from "../../common/ui/index.ts";
import { toolSummary } from "./chat-rows.ts";

/** User text is what the user typed; it is not Markdown and keeps its line breaks. */
export function UserMessageItem({ item }: { item: ChatUserMessage }) {
  return (
    <article
      aria-label="Your message"
      className="ml-auto max-w-xl rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap"
    >
      {item.text}
    </article>
  );
}

/** The agent's answer, rendered as streaming Markdown by the kit's Streamdown wrapper. */
export function AssistantMessageItem({ item }: { item: ChatAssistantMessage }) {
  return (
    <article aria-label="Agent message">
      <Markdown text={item.text} streaming={item.streaming} />
    </article>
  );
}

/**
 * Reasoning is one muted line (`layout.md`, **Chat**), collapsed by default. The contract carries
 * no timestamps, so the duration is measured from when this row first saw it streaming; a row
 * restored from a snapshot without that history says "Thought".
 */
export function ReasoningItem({ item }: { item: ChatReasoning }) {
  const [open, setOpen] = useState(false);
  const [seconds, setSeconds] = useState<number>();
  const startedAt = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (item.streaming) {
      startedAt.current ??= Date.now();
      return;
    }
    if (startedAt.current === undefined) return;
    setSeconds(Math.max(1, Math.round((Date.now() - startedAt.current) / 1000)));
    startedAt.current = undefined;
  }, [item.streaming]);
  const label =
    item.streaming || seconds === undefined
      ? item.streaming
        ? "Thinking…"
        : "Thought"
      : `Thought for ${seconds}s`;
  return (
    <div className="flex flex-col gap-1">
      <div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? "collapse" : "expand"} size="row" />
          <span className="text-xs text-muted-foreground">{label}</span>
        </Button>
      </div>
      {open && (
        <p className="m-0 whitespace-pre-wrap text-sm text-muted-foreground italic">{item.text}</p>
      )}
    </div>
  );
}

const TOOL_STATE: Readonly<Record<ChatToolStatus, AgentState>> = {
  running: "working",
  done: "done",
  error: "error",
};

/** One call: glyph, name, a shape-derived argument hint and its status, expandable in place. */
export function ToolCallItem({ item }: { item: ChatToolCall }) {
  const [open, setOpen] = useState(false);
  const summary = toolSummary(item.arguments);
  return (
    <div className="flex flex-col gap-1">
      <div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          aria-label={`${item.name} ${summary}`.trim()}
          onClick={() => setOpen((value) => !value)}
        >
          <StatusGlyph state={TOOL_STATE[item.status]} size="row" />
          <span className="max-w-48 shrink-0 truncate font-mono text-xs">{item.name}</span>
          {summary !== "" && (
            <span className="max-w-80 truncate text-xs text-muted-foreground">{summary}</span>
          )}
        </Button>
      </div>
      {open && (
        <div className="flex flex-col gap-2 pl-6">
          {item.arguments !== "" && (
            <div className="flex flex-col gap-1">
              <p className="m-0 text-xs text-muted-foreground">Arguments</p>
              <pre className="m-0 max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap">
                {item.arguments}
              </pre>
            </div>
          )}
          {item.diff !== null ? (
            <DiffView text={item.diff.text} path={item.diff.path} />
          ) : (
            item.output !== null && (
              <div className="flex flex-col gap-1">
                <p className="m-0 text-xs text-muted-foreground">Output</p>
                <pre className="m-0 max-h-64 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap">
                  {item.output}
                </pre>
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

/** A run of finished calls folds into one line until expanded (`layout.md`, **Chat**). */
export function ToolGroupItem({ items }: { items: readonly ChatToolCall[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <div>
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name={open ? "collapse" : "expand"} size="row" />
          <span className="text-xs text-muted-foreground">{items.length} tool calls</span>
        </Button>
      </div>
      {open && (
        <div className="flex flex-col gap-1 pl-6">
          {items.map((item) => (
            <ToolCallItem key={item.id} item={item} />
          ))}
        </div>
      )}
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
