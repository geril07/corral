import type { ChatAnswer, ChatItem } from "@corral/protocol/chat";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
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
      maintainScrollAtEnd
      recycleItems={false}
      className="h-full"
      data-testid="chat-timeline"
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
