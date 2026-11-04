import { useState } from "react";
import { ChatView, type ChatViewProps } from "../src/modules/chat/chat-view.tsx";

/** The consumer owns composer text, including in stand-alone view tests. */
export function ChatViewHarness(
  props: Omit<ChatViewProps, "draft" | "onDraftChange" | "canChooseAgent">,
) {
  const [draft, onDraftChange] = useState("");
  return <ChatView {...props} canChooseAgent={false} draft={draft} onDraftChange={onDraftChange} />;
}
