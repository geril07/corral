import type { ChatAnswer, ChatItem, ChatTurnState } from "@corral/protocol/chat";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chatRows, type ChatRow } from "./chat-rows.ts";
import { TranscriptRow } from "./chat-items.tsx";
import type { ChatTranscriptStore } from "./chat-transcript.ts";

export interface ChatTimelineProps {
  items: readonly ChatItem[];
  /** The session's turn: a working one keeps its newest work unfolded and shows the live tail. */
  turn: ChatTurnState;
  /** The agent is waiting on the user, so no work is happening and the live tail is not shown. */
  waiting: boolean;
  /** The pending request, when one needs the keyboard and must be scrolled into view. */
  requestId: string | undefined;
  /** The composer's measured height, so the last item is not hidden behind it. */
  endSpace: number;
  /** This session's reading row and open folds; the workspace keeps them across a tab switch. */
  memory: ChatTranscriptStore;
  /** The folds the user opened in this session. */
  expanded: ReadonlySet<string>;
  onToggleFold: (key: string) => void;
  onRespond: (requestId: string, value: ChatAnswer) => Promise<void>;
  onAnswered: () => void;
  /** A message action that failed says so in the pane's one failure line. */
  onFailure: (message: string) => void;
}

function atEnd(node: HTMLElement): boolean {
  return node.scrollTop + node.clientHeight >= node.scrollHeight - 2;
}

/**
 * The virtualized timeline (`@legendapp/list`): only the rows in and around the viewport are in
 * the DOM, and a streamed delta re-renders the list without mounting the transcript. It follows
 * the end while the user is at the end and releases the follow as soon as the user scrolls up.
 *
 * A mount is not a fresh session: the row the user was reading and the open folds come from the
 * workspace's memory for this session, so closing the tab and coming back lands where they were.
 */
export function ChatTimeline({
  items,
  turn,
  waiting,
  requestId,
  endSpace,
  memory,
  expanded,
  onToggleFold,
  onRespond,
  onAnswered,
  onFailure,
}: ChatTimelineProps) {
  const rows = useMemo(() => chatRows({ items, turn, waiting }), [items, turn, waiting]);
  const list = useRef<LegendListRef>(null);
  /** False after the user moved up, so a layout change below does not drag the view back. */
  /** The row this session was left on; read once, because a later mount is not a restore. */
  const [restored] = useState(() => memory.read().anchor);
  const [follow, setFollow] = useState(() => restored === undefined);
  const followConfig = useMemo(() => ({ on: { dataAppend: true, dataChange: true } }), []);

  const scrollNode = useCallback((): HTMLElement | null => {
    const node = list.current?.getScrollableNode();
    return node instanceof HTMLElement ? node : null;
  }, []);

  /**
   * The latch follows the list's own at-end state on every scroll, whatever moved it: a wheel, a
   * scrollbar or a key. That makes it reversible — a wheel back to the bottom re-arms it even after
   * a keyboard PageUp released it — instead of only the key handler writing the flag. The row
   * under the top edge goes to this session's memory, which is what a later mount restores.
   */
  const syncFollow = useCallback(() => {
    const state = list.current?.getState();
    if (state !== undefined) setFollow(state.isAtEnd);
    // The row under the top edge is the one a remount has to put back there; the list's own
    // anchor reports the row above it, which lands a turn early.
    const node = scrollNode();
    if (node === null) return;
    const box = node.getBoundingClientRect();
    const reading = [...node.querySelectorAll<HTMLElement>("[data-row-key]")].find(
      (row) => row.getBoundingClientRect().bottom > box.top + 1,
    );
    const key = reading?.dataset["rowKey"];
    if (key !== undefined) memory.remember({ key });
  }, [memory, scrollNode]);

  /** Keyboard scrolling: a move up releases the end follow, reaching the end takes it again. */
  const scrollBy = async (delta: number) => {
    const node = scrollNode();
    if (node === null) return;
    const before = node.scrollTop;
    const max = Math.max(0, node.scrollHeight - node.clientHeight);
    const target = Math.max(0, Math.min(max, before + delta));
    await list.current?.scrollToOffset({ offset: target, animated: false });
    const after = node.scrollTop;
    if (after < before - 1) setFollow(false);
    else if (atEnd(node)) setFollow(true);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Rows carry their own buttons; arrows in a row must not scroll the transcript.
    if (event.target !== event.currentTarget) return;
    const node = scrollNode();
    if (node === null) return;
    switch (event.key) {
      case "PageUp":
        event.preventDefault();
        void scrollBy(-node.clientHeight * 0.9);
        return;
      case "PageDown":
        event.preventDefault();
        void scrollBy(node.clientHeight * 0.9);
        return;
      case "ArrowUp":
        event.preventDefault();
        void scrollBy(-48);
        return;
      case "ArrowDown":
        event.preventDefault();
        void scrollBy(48);
        return;
      case "Home":
        event.preventDefault();
        setFollow(false);
        void list.current?.scrollToOffset({ offset: 0, animated: false }).then(() => {
          if (atEnd(node)) setFollow(true);
        });
        return;
      case "End":
        event.preventDefault();
        void list.current?.scrollToEnd({ animated: false }).then(() => setFollow(true));
        return;
      default:
        return;
    }
  };

  // A new request is the last item and takes focus; make sure virtualization made it visible.
  useEffect(() => {
    if (requestId === undefined) return;
    void list.current?.scrollToEnd({ animated: false });
  }, [requestId]);

  const renderItem = useCallback(
    ({ item }: { item: ChatRow }) => (
      // The row's identity in the DOM: a restore and a test can both name the row they mean.
      <div data-row-key={item.key}>
        <TranscriptRow
          row={item}
          expanded={expanded}
          onToggleFold={onToggleFold}
          onRespond={onRespond}
          onAnswered={onAnswered}
          onFailure={onFailure}
        />
      </div>
    ),
    [expanded, onToggleFold, onRespond, onAnswered, onFailure],
  );

  // A session that was scrolled before opens on the row it was reading; a fresh one at the tail.
  const anchorIndex =
    restored === undefined ? -1 : rows.findIndex((row) => row.key === restored.key);
  return (
    <LegendList
      ref={list}
      data={rows}
      keyExtractor={(row: ChatRow) => row.key}
      // A fold opens and closes outside the list's data, so the rows must re-render with it.
      extraData={expanded}
      renderItem={renderItem}
      estimatedItemSize={96}
      estimatedListSize={{ width: 720, height: 480 }}
      {...(anchorIndex >= 0
        ? { initialScrollIndex: { index: anchorIndex } }
        : restored === undefined
          ? { initialScrollAtEnd: true }
          : {})}
      alignItemsAtEnd
      maintainScrollAtEnd={follow ? followConfig : false}
      recycleItems={false}
      className="h-full"
      data-testid="chat-timeline"
      tabIndex={0}
      role="log"
      aria-label="Chat transcript"
      onScroll={syncFollow}
      onUserScroll={syncFollow}
      onKeyDown={onKeyDown}
      contentContainerStyle={{ paddingTop: 8, paddingBottom: endSpace + 8 }}
    />
  );
}
