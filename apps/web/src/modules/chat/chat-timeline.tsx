import type { ChatAnswer, ChatItem, ChatTurnState } from "@corral/protocol/chat";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { ContentLane } from "../../common/ui/index.ts";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { chatRows, terminalAssistantIds, type ChatRow } from "./chat-rows.ts";
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
  onAnswered: (requestId: string) => void;
  /** A message action that failed says so in the pane's one failure line. */
  onFailure: (message: string) => void;
  /**
   * The rows that arrived since the follow was released, or `null` while it holds. The control
   * that says so floats at the composer's top edge, which is the pane's to draw (`ScrollToEndButton`
   * in T3's `TimelineOverlays.tsx`), so the view reports the count and keeps the action.
   */
  onAway: (away: number | null) => void;
  /** That control's action; the view owns the list, so it owns the way back to the end. */
  scrollToEnd?: Ref<ChatTimelineScroll> | undefined;
}

/** The way back to the newest row, for the control above the composer. */
export interface ChatTimelineScroll {
  /**
   * Returns the view to the newest row and re-arms the follow. Returns the transcript's focusable
   * root: a keyboard press unmounts the control under the user, and the keys belong to the
   * transcript next, not to the body.
   */
  scrollToEnd: () => HTMLElement | null;
}

function atEnd(node: HTMLElement): boolean {
  return node.scrollTop + node.clientHeight >= node.scrollHeight - 2;
}

/**
 * The virtualized timeline (`@legendapp/list`): only the rows in and around the viewport are in
 * the DOM, and a streamed delta re-renders the list without mounting the transcript. It follows
 * the end while the user is at the end and releases the follow as soon as the user scrolls up;
 * while it is released, one control above the composer returns the view to the end and counts the
 * rows that arrived since (T3's `ScrollToEndButton` in `TimelineOverlays.tsx`).
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
  onAway,
  scrollToEnd,
}: ChatTimelineProps) {
  const rows = useMemo(() => chatRows({ items, turn, waiting }), [items, turn, waiting]);
  // The actions row belongs to each turn's answer; the projection's rows put it under the last
  // assistant message the same way (`hiddenKeys`).
  const actionsFor = useMemo(() => terminalAssistantIds(items), [items]);
  const list = useRef<LegendListRef>(null);
  /** What this session was left with; read once, because a later mount is not a restore. */
  const [restored] = useState(() => memory.read());
  const restoredAtEnd = restored.anchor === undefined || restored.atEnd;
  /** False after the user moved up, so a layout change below does not drag the view back. */
  const [follow, setFollow] = useState(restoredAtEnd);
  const [revealedRequest, setRevealedRequest] = useState<string>();
  /**
   * The row count the view held when it left the end. What the control above the composer counts
   * is everything past it, so a return to the end forgets it and the next release starts again.
   */
  const [leftAt, setLeftAt] = useState<number | null>(() => (restoredAtEnd ? null : rows.length));
  const followConfig = useMemo(() => ({ on: { dataAppend: true, dataChange: true } }), []);
  const extraData = useMemo(
    () => ({ expanded, revealedRequest, requestId }),
    [expanded, revealedRequest, requestId],
  );

  const scrollNode = useCallback((): HTMLElement | null => {
    const node = list.current?.getScrollableNode();
    return node instanceof HTMLElement ? node : null;
  }, []);

  /**
   * The count a release stamps comes from the last commit, through a ref so this stays stable:
   * `toggleFold` feeds `renderItem`, and a new identity there re-renders every mounted row on
   * every appended row.
   */
  const rowCount = useRef(rows.length);
  useEffect(() => {
    rowCount.current = rows.length;
  }, [rows.length]);

  /** Takes the end back, or releases it at the row the view is leaving from. */
  const setFollowing = useCallback((following: boolean) => {
    setFollow(following);
    setLeftAt((current) => (following ? null : (current ?? rowCount.current)));
  }, []);

  /**
   * The latch follows the list's own at-end state on every scroll, whatever moved it: a wheel, a
   * scrollbar or a key. That makes it reversible — a wheel back to the bottom re-arms it even after
   * a keyboard PageUp released it — instead of only the key handler writing the flag. The row
   * under the top edge goes to this session's memory, which is what a later mount restores.
   */
  const syncFollow = useCallback(() => {
    const state = list.current?.getState();
    if (state !== undefined) setFollowing(state.isAtEnd);
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
  }, [memory, rows, scrollNode, setFollowing]);

  const away = follow || leftAt === null ? null : Math.max(0, rows.length - leftAt);
  useEffect(() => {
    onAway(away);
  }, [away, onAway]);

  /**
   * Opens or closes a fold without letting the list drag the view to it. A list that is following
   * its end ignores a held anchor ("returns the anchor without interrupting end following"), so
   * that follow is released before the layout changes; two frames later the latch is taken from
   * where the layout actually left the view, which keeps the end following after a disclosure that
   * closed and releases it after one that grew the content under the user. T3 suspends its
   * end-scroll maintenance for a disclosure for the same reason (`MessagesTimeline.tsx`).
   */
  const toggleFold = useCallback(
    (key: string) => {
      if (list.current?.getState().isFollowingEnd === true) list.current.cancelScroll();
      onToggleFold(key);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const node = scrollNode();
          if (node !== null) setFollowing(atEnd(node));
        });
      });
    },
    [onToggleFold, scrollNode, setFollowing],
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
    if (after < before - 1) setFollowing(false);
    else if (atEnd(node)) setFollowing(true);
  };

  /**
   * The pointer's way back to the end, called by the control above the composer. End does the
   * same from the keyboard. The focusable root comes back with it because a keyboard press
   * unmounts the control under the user: the transcript, not the body, owns the keys next.
   */
  useImperativeHandle(
    scrollToEnd,
    () => ({
      scrollToEnd: () => {
        void list.current?.scrollToEnd({ animated: false }).then(() => setFollowing(true));
        const node = scrollNode();
        return node?.closest<HTMLElement>('[role="log"]') ?? node;
      },
    }),
    [scrollNode, setFollowing],
  );

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
        setFollowing(false);
        void list.current?.scrollToOffset({ offset: 0, animated: false }).then(() => {
          if (atEnd(node)) setFollowing(true);
        });
        return;
      case "End":
        event.preventDefault();
        void list.current?.scrollToEnd({ animated: false }).then(() => setFollowing(true));
        return;
      default:
        return;
    }
  };

  const requestIndex = rows.findIndex(
    (row) =>
      (row.kind === "item" && row.item.id === requestId) ||
      (row.kind === "turn" &&
        row.rows.some((inner) => inner.kind === "item" && inner.item.id === requestId)),
  );

  // A request can be inside a turn row, and an older pending request can be far from the tail.
  // First mount its outer row, then let the request focus and reveal its own control.
  useEffect(() => {
    if (requestId === undefined || requestIndex < 0) return undefined;
    let cancelled = false;
    const target = list.current;
    if (target === null) return undefined;
    target.cancelScroll();
    setFollow(false);
    // The jump spends the count: what arrived before it is not what waits below the request.
    setLeftAt(null);
    void target
      .scrollToIndex({ index: requestIndex, animated: false, viewPosition: 0 })
      .then(() => {
        if (!cancelled) setRevealedRequest(requestId);
      });
    return () => {
      cancelled = true;
    };
  }, [requestId, requestIndex]);

  const renderItem = useCallback(
    ({ item }: { item: ChatRow }) => (
      // The list spans the pane for its scrollbar, so each row carries the session lane itself.
      <ContentLane className="mx-auto">
        {/* The row's identity in the DOM: a restore and a test can both name the row they mean. */}
        <div data-row-key={item.key}>
          <TranscriptRow
            row={item}
            expanded={expanded}
            onToggleFold={toggleFold}
            onRespond={onRespond}
            onAnswered={onAnswered}
            onFailure={onFailure}
            waiting={waiting}
            focusedRequest={revealedRequest === requestId ? requestId : undefined}
            actionsFor={actionsFor}
          />
        </div>
      </ContentLane>
    ),
    [
      expanded,
      toggleFold,
      onRespond,
      onAnswered,
      onFailure,
      waiting,
      revealedRequest,
      requestId,
      actionsFor,
    ],
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
      // Folds and selected request change outside the list's row data.
      extraData={extraData}
      renderItem={renderItem}
      estimatedItemSize={96}
      estimatedListSize={{ width: 720, height: 480 }}
      {...(remembered === undefined || restored.atEnd || startIndex < 0
        ? { initialScrollAtEnd: true }
        : { initialScrollIndex: { index: startIndex } })}
      alignItemsAtEnd
      maintainScrollAtEnd={follow && requestId === undefined ? followConfig : false}
      recycleItems={false}
      className="h-full overflow-anchor-none"
      data-testid="chat-timeline"
      tabIndex={0}
      role="log"
      aria-label="Chat transcript"
      onScroll={syncFollow}
      onUserScroll={syncFollow}
      onKeyDown={onKeyDown}
      contentContainerStyle={{
        paddingTop: 8,
        paddingBottom: endSpace + 8,
        // The gutter the scrollbar will take is inside the scroller, so the bar stays at the pane's
        // edge; the rows keep the same inset from the pane's sides at narrow widths.
        paddingLeft: 16,
        paddingRight: 16,
      }}
    />
  );
}
