import { useState } from "react";
import { ChatView, type ChatViewProps } from "../src/modules/chat/chat-view.tsx";

/** The consumer owns composer text and the shared abort state, including in view tests. */
export function ChatViewHarness(
  props: Omit<ChatViewProps, "draft" | "onDraftChange" | "canChooseAgent" | "aborting">,
) {
  const [draft, onDraftChange] = useState("");
  const [aborting, setAborting] = useState(false);
  const abort = async () => {
    if (aborting) return;
    setAborting(true);
    try {
      await props.onAbort();
    } finally {
      setAborting(false);
    }
  };
  return (
    <ChatView
      {...props}
      canChooseAgent={false}
      draft={draft}
      onDraftChange={onDraftChange}
      aborting={aborting}
      onAbort={abort}
    />
  );
}
