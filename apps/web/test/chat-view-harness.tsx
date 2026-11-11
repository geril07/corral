import { useState } from "react";
import { ChatView, chatTranscriptStore, type ChatViewProps } from "../src/modules/chat/index.ts";

/** The consumer owns composer text and the shared abort state, including in view tests. */
export function ChatViewHarness(
  props: Omit<
    ChatViewProps,
    "draft" | "onDraftChange" | "canChooseAgent" | "aborting" | "memory"
  > & {
    /** Pass the same memory twice to prove a tab switch keeps this session's place. */
    memory?: ChatViewProps["memory"];
  },
) {
  const [draft, onDraftChange] = useState("");
  const [aborting, setAborting] = useState(false);
  const [ownMemory] = useState(chatTranscriptStore);
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
      memory={props.memory ?? ownMemory}
      canChooseAgent={false}
      draft={draft}
      onDraftChange={onDraftChange}
      aborting={aborting}
      onAbort={abort}
    />
  );
}
