import type { ChatStore } from "@corral/client/chat-store";
import { describeError } from "@corral/client/rpc-errors";
import type { ChatAnswer } from "@corral/protocol/chat";
import type { AgentKind, ChatSendMode } from "@corral/protocol/rpc";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type MouseEvent,
  type SetStateAction,
  type Ref,
} from "react";
import { useEnterGuard } from "../../common/hooks/use-enter-guard.ts";
import {
  Alert,
  AlertDescription,
  Button,
  ComposerSurface,
  ComposerToolbar,
  ContentLane,
  ModelPickerButton,
  Textarea,
  useTruncatedText,
} from "../../common/ui/index.ts";
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
  /** Workspace-owned per-session text survives replacing the chat with another view. */
  draft: string;
  onDraftChange: Dispatch<SetStateAction<string>>;
  /** The agent's name for the placeholder ("Ask pi…"); the session's kind. */
  agent: AgentKind;
  /**
   * The matched driver's `followUp` declaration. `undefined` until the capabilities answer, or
   * when this build has no record for the agent, keeps today's offer instead of stripping it.
   */
  followUp: boolean | undefined;
  canChooseAgent: boolean;
  modelPickerAnchor?: Ref<HTMLButtonElement> | undefined;
  reasoningPickerAnchor?: Ref<HTMLButtonElement> | undefined;
  /** The abort action's effective chord (`formatBinding`), or undefined when it is unbound. */
  abortHint: string | undefined;
  onSend: ChatSend;
  /** Shared by the button, prefix and palette; true while the abort RPC is pending. */
  aborting: boolean;
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
  draft,
  onDraftChange: setDraft,
  agent,
  followUp,
  canChooseAgent,
  modelPickerAnchor,
  reasoningPickerAnchor,
  abortHint,
  onSend,
  aborting,
  onAbort,
  onRespond,
  onChangeModel,
  onChangeReasoning,
  files,
}: ChatViewProps) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const reasoning = snapshot.state.reasoning ?? "Thinking";
  const { observe: observeReasoning, clipped: clippedReasoning } = useTruncatedText(reasoning);
  const [sending, setSending] = useState(false);
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
  // A driver that does not declare follow-ups gets steer from both Enter and the chord, and the
  // hint names only the actions it does offer (`chat.capabilities`, protocol 10).
  const followUpOffered = followUp !== false;
  const workingHint = followUpOffered
    ? `Enter steer · ⌘/Ctrl+Enter follow-up · ${abortHint ?? "no key"} abort`
    : `Enter steer · ${abortHint ?? "no key"} abort`;

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

  // A keyboard activation has the button focused; move the keyboard back before the action
  // disables it, because Chromium drops a disabled button's focus to <body>. A pointer press
  // never focuses the button (`onMouseDown` below), so focus stays where the user left it.
  const keepKeyboardInComposer = (event: MouseEvent<HTMLButtonElement>) => {
    if (document.activeElement === event.currentTarget) focusComposer();
  };

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
    setFailure(undefined);
    try {
      await onAbort();
    } catch (error) {
      setFailure(describeError(error));
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
              <ComposerSurface>
                <Textarea
                  frame="composer"
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
                    else if (followUpOffered && (event.metaKey || event.ctrlKey))
                      void send("follow-up");
                    else void send("steer");
                  }}
                />
                <ComposerToolbar busy={aborting}>
                  <ModelPickerButton
                    ref={modelPickerAnchor}
                    kind={agent}
                    label={snapshot.state.model?.name ?? "Choose model"}
                    aria-label={`Model ${snapshot.state.model?.name ?? "none"}`}
                    disabled={!canChooseAgent && snapshot.state.models.length === 0}
                    onClick={onChangeModel}
                  />
                  <Button
                    ref={reasoningPickerAnchor}
                    variant="ghost"
                    size="sm"
                    aria-label={`Reasoning ${snapshot.state.reasoning ?? "none"}`}
                    disabled={snapshot.state.reasoningLevels.length === 0}
                    onClick={onChangeReasoning}
                  >
                    <span
                      ref={observeReasoning}
                      className="min-w-0 truncate"
                      title={clippedReasoning ? reasoning : undefined}
                    >
                      {reasoning}
                    </span>
                  </Button>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {working ? workingHint : "Enter send · Shift+Enter newline"}
                  </span>
                  {working && (
                    <>
                      {followUpOffered && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={draft.trim() === "" || sending}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={(event) => {
                            keepKeyboardInComposer(event);
                            void send("follow-up");
                          }}
                        >
                          Queue
                        </Button>
                      )}
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={aborting}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={(event) => {
                          keepKeyboardInComposer(event);
                          void abort();
                        }}
                      >
                        {aborting ? "Stopping…" : "Abort"}
                      </Button>
                    </>
                  )}
                  <Button
                    type="submit"
                    size="sm"
                    disabled={draft.trim() === "" || sending}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={keepKeyboardInComposer}
                  >
                    {working ? "Steer" : "Send"}
                  </Button>
                </ComposerToolbar>
              </ComposerSurface>
            </form>
          </div>
        </ContentLane>
      </div>
    </LocalLinks>
  );
}
