import type { ChatAnswer, ChatItem, ChatTurnState } from "@corral/protocol/chat";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chatRows, type ChatRow } from "./chat-rows.ts";
import { TranscriptRow } from "./chat-items.tsx";
import type { ChatTranscriptStore } from "./chat-transcript.ts";

export interface ChatTimelineProps {
  items: readonly ChatItem[];
  /** A working session keeps all turns unfolded and shows the live tail. */
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
  /** What this session was left with; read once, because a later mount is not a restore. */
  const [restored] = useState(() => memory.read());
  /** False after the user moved up, so a layout change below does not drag the view back. */
  const [follow, setFollow] = useState(() => restored.anchor === undefined || restored.atEnd);
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
    if (key === undefined) return;
    memory.remember(
      { key, index: rows.findIndex((row) => row.key === key) },
      state?.isAtEnd ?? atEnd(node),
    );
  }, [memory, rows, scrollNode]);

  /**
   * Opens or closes a fold without letting the list drag the view to it. A list that is following
   * its end ignores a held anchor ("returns the anchor without interrupting end following"), so
   * that follow is released before the layout changes; two frames later the latch is taken from
   * where the layout actually left the view, which keeps the end following after a disclosure that
   * closed and releases it after one that grew the content under the user. T3 suspends its
   * end-scroll maintenance for a disclosure for the same reason (`MessagesTimeline.tsx:490-536`).
   */
  const toggleFold = useCallback(
    (key: string) => {
      if (list.current?.getState().isFollowingEnd === true) list.current.cancelScroll();
      onToggleFold(key);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const node = scrollNode();
          if (node !== null) setFollow(atEnd(node));
        });
      });
    },
    [onToggleFold, scrollNode],
  );

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
    if (requestId === undefined || !follow) return;
    void list.current?.scrollToEnd({ animated: false });
  }, [requestId, follow]);

  const renderItem = useCallback(
    ({ item }: { item: ChatRow }) => (
      // The row's identity in the DOM: a restore and a test can both name the row they mean.
      <div data-row-key={item.key}>
        <TranscriptRow
          row={item}
          expanded={expanded}
          onToggleFold={toggleFold}
          onRespond={onRespond}
          onAnswered={onAnswered}
          onFailure={onFailure}
          waiting={waiting}
        />
      </div>
    ),
    [expanded, toggleFold, onRespond, onAnswered, onFailure, waiting],
  );

  /**
   * A session that was scrolled before opens on the row it was reading, and one that was at the
   * end opens at the end. A remembered row that no longer exists — the fold that held it is
   * closed again — falls back to the row at the same index, then to the end.
   */
  const remembered = restored.anchor;
  const anchorIndex =
    remembered === undefined ? -1 : rows.findIndex((row) => row.key === remembered.key);
  const startIndex =
    remembered === undefined
      ? -1
      : anchorIndex >= 0
        ? anchorIndex
        : Math.min(remembered.index, rows.length - 1);
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
      {...(remembered === undefined || restored.atEnd || startIndex < 0
        ? { initialScrollAtEnd: true }
        : { initialScrollIndex: { index: startIndex } })}
      alignItemsAtEnd
      maintainScrollAtEnd={follow ? followConfig : false}
      recycleItems={false}
      className="h-full overflow-anchor-none"
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
