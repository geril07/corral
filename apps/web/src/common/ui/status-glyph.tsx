import type { AgentState } from "@corral/protocol/rpc";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn.ts";

const glyphVariants = cva("inline-flex size-3.5 shrink-0 items-center justify-center", {
  variants: {
    state: {
      blocked: "text-status-blocked",
      error: "text-status-error",
      working: "text-status-working",
      done: "text-status-done",
      idle: "text-status-idle",
      none: "text-status-idle",
    },
  },
  defaultVariants: { state: "none" },
});

/**
 * The agent's state as a fixed-size shape, so no state relies on colour alone and none renders
 * smaller than the others because of font fallback.
 */
export function StatusGlyph({
  state,
  className,
}: { state: AgentState | undefined; className?: string } & VariantProps<typeof glyphVariants>) {
  return (
    <span className={cn(glyphVariants({ state: state ?? "none" }), className)} aria-hidden>
      <Glyph state={state} />
    </span>
  );
}

function Glyph({ state }: { state: AgentState | undefined }) {
  if (state === "blocked")
    return (
      <svg viewBox="0 0 16 16" className="size-3.5" fill="currentColor">
        <path d="M8 1.5 15 14H1Z" />
      </svg>
    );
  if (state === "error")
    return (
      <svg
        viewBox="0 0 16 16"
        className="size-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5" />
      </svg>
    );
  if (state === "working")
    return (
      <svg viewBox="0 0 16 16" className="size-3.5">
        <circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 1.5a6.5 6.5 0 0 1 0 13Z" fill="currentColor" />
      </svg>
    );
  if (state === "done")
    return (
      <svg
        viewBox="0 0 16 16"
        className="size-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path d="m2.5 8.5 3.5 3.5 7.5-8" />
      </svg>
    );
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <circle cx="8" cy="8" r="6.5" />
    </svg>
  );
}
