import { createFileRoute } from "@tanstack/react-router";
import { VisualReview } from "../modules/shell/index.ts";

/** Development-only review host; production renders an explicit unavailable notice. */
export const Route = createFileRoute("/visual-review")({ component: VisualReview });
