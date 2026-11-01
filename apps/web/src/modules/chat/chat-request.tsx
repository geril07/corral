import type { ChatAnswer, ChatUserRequest } from "@corral/protocol/chat";
import { describeError } from "@corral/client/rpc-errors";
import { useEffect, useRef, useState } from "react";
import { Badge, Button, Input, StatusGlyph, Textarea } from "../../common/ui/index.ts";

/** What a recorded or live answer reads as in the timeline after the request is resolved. */
function answerLabel(item: ChatUserRequest): string {
  if (item.status === "expired") return "Expired";
  if (item.status === "pending") return "";
  if (item.answer === null || item.answer === undefined) return "Dismissed";
  if (typeof item.answer === "boolean") return item.answer ? "Yes" : "No";
  const option = item.options.find((each) => each.value === item.answer);
  return option?.label ?? item.answer;
}

/**
 * A request the agent is blocked on (`layout.md`, **Chat**: it is the last timeline item and takes
 * the keyboard). Every kind is answerable without a pointer: arrows and Enter for `select` and
 * `confirm`, Enter for `input`, Ctrl/Cmd+Enter for `editor`, and Escape dismisses any of them with
 * `null` (`chat.respond`).
 */
export function ChatRequestItem({
  item,
  onRespond,
  onAnswered,
}: {
  item: ChatUserRequest;
  onRespond: (value: ChatAnswer) => Promise<void>;
  onAnswered: () => void;
}) {
  const [active, setActive] = useState(0);
  const [text, setText] = useState(item.prefill ?? "");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const pending = item.status === "pending";

  // The request owns the keyboard when it arrives (`layout.md`, **Chat**); a select/confirm starts
  // on its first choice and moves with the arrow keys.
  useEffect(() => {
    if (!pending) return;
    if (item.request === "input" || item.request === "editor") fieldRef.current?.focus();
    else optionRefs.current[active]?.focus();
  }, [pending, item.request, active]);

  const answer = async (value: ChatAnswer) => {
    if (!pending || busy) return;
    setBusy(true);
    setFailure(undefined);
    try {
      await onRespond(value);
      onAnswered();
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  const step = (offset: 1 | -1, count: number) => {
    setActive((current) => (current + offset + count) % count);
  };

  const choices =
    item.request === "confirm"
      ? [
          { value: true, label: "Yes" },
          { value: false, label: "No" },
        ]
      : item.request === "select"
        ? item.options.map((option) => ({ value: option.value, label: option.label }))
        : [];

  return (
    <section
      aria-label="Agent request"
      className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3"
      onKeyDown={(event) => {
        if (!pending) return;
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          void answer(null);
          return;
        }
        if (item.request !== "select" && item.request !== "confirm") return;
        if (event.key === "ArrowDown" || event.key === "ArrowRight") {
          event.preventDefault();
          step(1, choices.length);
          return;
        }
        if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
          event.preventDefault();
          step(-1, choices.length);
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          const choice = choices[active];
          if (choice !== undefined) void answer(choice.value);
        }
      }}
    >
      <div className="flex items-start gap-2">
        <StatusGlyph state="blocked" size="row" />
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="m-0 text-sm font-semibold">{item.title}</h3>
          {item.body !== null && (
            <p className="m-0 whitespace-pre-wrap text-sm text-muted-foreground">{item.body}</p>
          )}
        </div>
        {pending && <Badge variant="secondary">needs you</Badge>}
      </div>

      {!pending ? (
        <p className="m-0 text-xs text-muted-foreground">
          {item.status === "expired" ? "Expired" : `Answered: ${answerLabel(item)}`}
        </p>
      ) : item.request === "select" || item.request === "confirm" ? (
        <div role="radiogroup" aria-label={item.title} className="flex flex-col items-start gap-1">
          {choices.map((choice, index) => (
            <Button
              key={String(choice.value)}
              ref={(node) => {
                optionRefs.current[index] = node;
              }}
              role="radio"
              aria-checked={index === active}
              tabIndex={index === active ? 0 : -1}
              variant={index === active ? "secondary" : "ghost"}
              size="sm"
              disabled={busy}
              onClick={() => {
                setActive(index);
                void answer(choice.value);
              }}
            >
              {choice.label}
              {item.request === "select" && (
                <span className="max-w-64 truncate text-xs text-muted-foreground">
                  {item.options[index]?.description ?? ""}
                </span>
              )}
            </Button>
          ))}
        </div>
      ) : item.request === "input" ? (
        <div className="flex flex-col gap-2">
          <Input
            ref={(node) => {
              fieldRef.current = node;
            }}
            aria-label={item.title}
            placeholder={item.placeholder ?? ""}
            value={text}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              if (event.nativeEvent.isComposing) return;
              event.preventDefault();
              if (text.trim() !== "") void answer(text);
            }}
          />
          <div>
            <Button
              size="sm"
              disabled={busy || text.trim() === ""}
              onClick={() => void answer(text)}
            >
              Answer
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Textarea
            ref={(node) => {
              fieldRef.current = node;
            }}
            layout="chat"
            aria-label={item.title}
            placeholder={item.placeholder ?? ""}
            rows={4}
            value={text}
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
              event.preventDefault();
              if (text.trim() !== "") void answer(text);
            }}
          />
          <div>
            <Button
              size="sm"
              disabled={busy || text.trim() === ""}
              onClick={() => void answer(text)}
            >
              Answer
            </Button>
          </div>
        </div>
      )}

      {failure !== undefined && (
        <p className="m-0 text-sm text-destructive" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}
