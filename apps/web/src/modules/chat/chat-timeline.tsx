import type { ChatAnswer, ChatItem } from "@corral/protocol/chat";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chatRows, type ChatRow } from "./chat-rows.ts";
import {
  AssistantMessageItem,
  ErrorItem,
  NoticeItem,
  ReasoningItem,
  ToolCallItem,
  ToolGroupItem,
  UserMessageItem,
} from "./chat-items.tsx";
import { ChatRequestItem } from "./chat-request.tsx";

export interface ChatTimelineProps {
  items: readonly ChatItem[];
  /** The pending request, when one needs the keyboard and must be scrolled into view. */
  requestId: string | undefined;
  /** The composer's measured height, so the last item is not hidden behind it. */
  endSpace: number;
  onRespond: (requestId: string, value: ChatAnswer) => Promise<void>;
  onAnswered: () => void;
}

function atEnd(node: HTMLElement): boolean {
  return node.scrollTop + node.clientHeight >= node.scrollHeight - 2;
}

/**
 * The virtualized timeline (`@legendapp/list`): only the rows in and around the viewport are in
 * the DOM, and a streamed delta re-renders the list without mounting the transcript. It follows
 * the end while the user is at the end and releases the follow as soon as the user scrolls up.
 */
export function ChatTimeline({
  items,
  requestId,
  endSpace,
  onRespond,
  onAnswered,
}: ChatTimelineProps) {
  const rows = useMemo(() => chatRows(items), [items]);
  const list = useRef<LegendListRef>(null);
  /** False after the user moved up, so a layout change below does not drag the view back. */
  const [follow, setFollow] = useState(true);
  const followConfig = useMemo(() => ({ on: { dataAppend: true, dataChange: true } }), []);

  const scrollNode = (): HTMLElement | null => {
    const node = list.current?.getScrollableNode();
    return node instanceof HTMLElement ? node : null;
  };

  /**
   * The latch follows the list's own at-end state on every scroll, whatever moved it: a wheel, a
   * scrollbar or a key. That makes it reversible — a wheel back to the bottom re-arms it even after
   * a keyboard PageUp released it — instead of only the key handler writing the flag.
   */
  const syncFollow = useCallback(() => {
    const state = list.current?.getState();
    if (state !== undefined) setFollow(state.isAtEnd);
  }, []);

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
      <ChatRowView row={item} onRespond={onRespond} onAnswered={onAnswered} />
    ),
    [onRespond, onAnswered],
  );

  return (
    <LegendList
      ref={list}
      data={rows}
      keyExtractor={(row: ChatRow) => row.key}
      renderItem={renderItem}
      estimatedItemSize={96}
      estimatedListSize={{ width: 720, height: 480 }}
      initialScrollAtEnd
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

function ChatRowView({
  row,
  onRespond,
  onAnswered,
}: {
  row: ChatRow;
  onRespond: (requestId: string, value: ChatAnswer) => Promise<void>;
  onAnswered: () => void;
}) {
  if (row.kind === "tools") return <ToolGroupItem items={row.items} />;
  const { item } = row;
  switch (item.kind) {
    case "user-message":
      return <UserMessageItem item={item} />;
    case "assistant-message":
      return <AssistantMessageItem item={item} />;
    case "reasoning":
      return <ReasoningItem item={item} />;
    case "tool-call":
      return <ToolCallItem item={item} />;
    case "user-request":
      return (
        <ChatRequestItem
          item={item}
          onRespond={(value) => onRespond(item.id, value)}
          onAnswered={onAnswered}
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
