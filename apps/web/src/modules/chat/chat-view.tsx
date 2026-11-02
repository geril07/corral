import type { ChatStore } from "@corral/client/chat-store";
import { describeError } from "@corral/client/rpc-errors";
import type { ChatAnswer } from "@corral/protocol/chat";
import type { ChatSendMode } from "@corral/protocol/rpc";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useEnterGuard } from "../../common/hooks/use-enter-guard.ts";
import { Alert, AlertDescription, Button, ContentLane, Textarea } from "../../common/ui/index.ts";
import { pendingRequest } from "./chat-rows.ts";
import { ChatTimeline } from "./chat-timeline.tsx";
import {
  LocalLinkFailure,
  LocalLinks,
  LocalLinksUnavailable,
  type ChatFiles,
} from "./local-links.tsx";

/** How the composer turns its text into a `chat.send` while a turn runs (`design.md`, D2). */
export type ChatSend = (text: string, mode: ChatSendMode) => Promise<void>;

export interface ChatViewProps {
  store: ChatStore;
  /** The agent's name for the placeholder ("Ask pi…"); the session's kind. */
  agent: string;
  /** The abort action's effective chord (`formatBinding`), or undefined when it is unbound. */
  abortHint: string | undefined;
  onSend: ChatSend;
  onAbort: () => Promise<void>;
  onRespond: (requestId: string, value: ChatAnswer) => Promise<void>;
  /** Opens the model chooser; the workspace owns the dialog so the palette can open it too. */
  onChangeModel: () => void;
  /** Opens the reasoning-level chooser, likewise. */
  onChangeReasoning: () => void;
  /** Local links of the messages: resolved against the task's workspace by the workspace. */
  files: ChatFiles;
}

/**
 * One session as chat (`layout.md`, **Chat**): the 46 rem lane, the virtualized timeline, the
 * request the agent waits on, and the composer that overlays the lane's end. The view renders the
 * B0 store; the workspace owns the connection calls (goal D4: no driver is needed here).
 */
export function ChatView({
  store,
  agent,
  abortHint,
  onSend,
  onAbort,
  onRespond,
  onChangeModel,
  onChangeReasoning,
  files,
}: ChatViewProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [failure, setFailure] = useState<string>();
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelHeight, setPanelHeight] = useState(0);
  const guard = useEnterGuard();
  const request = pendingRequest(snapshot.items);
  // Only assistant text is linkified: a user's own words, reasoning and tool output stay as written.
  const texts = useMemo(
    () => snapshot.items.flatMap((item) => (item.kind === "assistant-message" ? [item.text] : [])),
    [snapshot.items],
  );
  const requestId = request?.id;
  const working = snapshot.state.turn === "working";

  // The composer overlays the timeline, so the list keeps a matching end spacer
  // (`layout.md`: "at the bottom of the lane, overlaying the timeline's end").
  useEffect(() => {
    const node = panelRef.current;
    if (node === null) return undefined;
    const measure = () => setPanelHeight(node.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const focusComposer = useCallback(() => composerRef.current?.focus(), []);

  // A request takes the keyboard when it arrives; answering it hands the keyboard back.
  useEffect(() => {
    if (requestId === undefined) focusComposer();
    else composerRef.current?.blur();
  }, [requestId, focusComposer]);

  const send = async (mode: ChatSendMode) => {
    const text = draft.trim();
    if (text === "" || sending) return;
    setSending(true);
    setFailure(undefined);
    try {
      await onSend(text, mode);
      // Keep anything typed while the send was in flight; clear only what was sent.
      setDraft((current) => (current.trim() === text ? "" : current));
    } catch (error) {
      // A refused send keeps the text, so the user does not type it again (`ux.md`, errors).
      setFailure(describeError(error));
    } finally {
      setSending(false);
    }
  };

  const abort = async () => {
    if (aborting) return;
    setAborting(true);
    setFailure(undefined);
    try {
      await onAbort();
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setAborting(false);
    }
  };

  const hints =
    snapshot.state.steering.length + snapshot.state.followUp.length > 0 ? (
      <div className="flex flex-col gap-0.5">
        {/* A repeated queued message is legal, so its position is the identity here. */}
        {snapshot.state.steering.map((text, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- duplicates are allowed
          <p key={`steer-${index}`} className="m-0 truncate text-xs text-muted-foreground">
            Steering: {text}
          </p>
        ))}
        {snapshot.state.followUp.map((text, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- duplicates are allowed
          <p key={`follow-${index}`} className="m-0 truncate text-xs text-muted-foreground">
            Queued: {text}
          </p>
        ))}
      </div>
    ) : undefined;

  return (
    <LocalLinks files={files} texts={texts}>
      <div className="flex h-full min-h-0 justify-center px-4">
        <ContentLane className="relative h-full min-h-0">
          <div className="relative min-h-0 flex-1">
            <div className="absolute inset-0">
              <ChatTimeline
                items={snapshot.items}
                requestId={request?.id}
                endSpace={panelHeight}
                onRespond={onRespond}
                onAnswered={focusComposer}
              />
            </div>
          </div>
          <div
            ref={panelRef}
            className="absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-background pt-2"
          >
            {snapshot.failure !== null && (
              <Alert variant="destructive">
                <AlertDescription>{snapshot.failure.message}</AlertDescription>
              </Alert>
            )}
            {failure !== undefined && (
              <p className="m-0 text-sm text-destructive" role="alert">
                {failure}
              </p>
            )}
            <LocalLinkFailure />
            <LocalLinksUnavailable />
            {hints}
            <form
              aria-label="Chat message"
              className="flex flex-col gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                void send(working ? "steer" : "prompt");
              }}
            >
              <Textarea
                ref={composerRef}
                layout="chat"
                aria-label="Message"
                placeholder={`Ask ${agent}…`}
                rows={2}
                spellCheck={false}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onCompositionStart={guard.start}
                onCompositionEnd={guard.end}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") {
                    guard.noteKey(event.key);
                    return;
                  }
                  // An IME commit is not a send, in either platform ordering.
                  if (guard.isComposition(event)) {
                    guard.consume();
                    event.preventDefault();
                    return;
                  }
                  // Shift+Enter stays a newline; the textarea's own default does that.
                  if (event.shiftKey) return;
                  event.preventDefault();
                  if (!working) void send("prompt");
                  else void send(event.metaKey || event.ctrlKey ? "follow-up" : "steer");
                }}
              />
              <div className="flex flex-wrap items-center gap-2">
                {/* The two pickers `layout.md` puts on the left; each opens the same chooser the
                  palette's actions open, so the driver's list is one component. */}
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Model ${snapshot.state.model?.name ?? "none"}`}
                  disabled={snapshot.state.models.length === 0}
                  onClick={onChangeModel}
                >
                  <span className="min-w-0 truncate">
                    {snapshot.state.model?.name ?? "no model"}
                  </span>
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Reasoning ${snapshot.state.reasoning ?? "none"}`}
                  disabled={snapshot.state.reasoningLevels.length === 0}
                  onClick={onChangeReasoning}
                >
                  <span className="min-w-0 truncate">
                    {snapshot.state.reasoning ?? "no reasoning level"}
                  </span>
                </Button>
                <span className="ml-auto text-xs text-muted-foreground">
                  {working
                    ? `Enter steer · ⌘/Ctrl+Enter follow-up · ${abortHint ?? "no key"} abort`
                    : "Enter send · Shift+Enter newline"}
                </span>
                {working && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={draft.trim() === "" || sending}
                      onClick={() => void send("follow-up")}
                    >
                      Queue
                    </Button>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={aborting}
                      onClick={() => void abort()}
                    >
                      Abort
                    </Button>
                  </>
                )}
                <Button type="submit" size="sm" disabled={draft.trim() === "" || sending}>
                  {working ? "Steer" : "Send"}
                </Button>
              </div>
            </form>
          </div>
        </ContentLane>
      </div>
    </LocalLinks>
  );
}
