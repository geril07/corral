import { createFileRoute } from "@tanstack/react-router";
import { ChatReview } from "../modules/chat/index.ts";

/** Development-only review host for chat rows; production renders an explicit unavailable notice. */
export const Route = createFileRoute("/chat-review")({ component: ChatReview });
