import type { AgentState } from "@corral/protocol/rpc";
import { Icon } from "./icon.tsx";

/** Shape and the caller's accessible name distinguish states without a custom color palette. */
export function StatusGlyph({ state }: { state: AgentState | undefined }) {
  return (
    <span className={state === "error" ? "text-destructive" : "text-muted-foreground"} aria-hidden>
      <Icon name={`status-${state ?? "idle"}`} />
    </span>
  );
}
