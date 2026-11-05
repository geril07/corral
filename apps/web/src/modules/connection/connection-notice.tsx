import type { ConnectionState } from "@corral/client/connection-state";
import { Button, StatusGlyph } from "../../common/ui/index.ts";
import { useNow } from "../../common/hooks/use-now.ts";

/**
 * The footer's connection opener. Connected shows nothing; every other state names itself,
 * the attempt and its elapsed time, and opens the recovery dialog that carries the capability
 * field. The long bootstrap sentence lives on that surface, not in this row.
 */
export function ConnectionNotice({
  state,
  onOpen,
}: {
  state: ConnectionState;
  onOpen?: (opener: HTMLElement) => void;
}) {
  const now = useNow(1000);
  if (state.status === "connected") return null;
  const label = describe(state, now);
  const content = (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <StatusGlyph state={GLYPH_STATE[state.status]} />
      <span className="truncate">{label.text}</span>
    </span>
  );
  if (onOpen === undefined) {
    return (
      <span
        className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground"
        role="status"
        aria-label={`connection: ${label.name}`}
      >
        {content}
      </span>
    );
  }
  return (
    <Button
      variant="ghost"
      size="xs"
      layout="status"
      aria-label={`connection: ${label.name}`}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      {content}
    </Button>
  );
}

function describe(
  state: Exclude<ConnectionState, { status: "connected" }>,
  now: number,
): { name: string; text: string } {
  switch (state.status) {
    case "connecting":
      return {
        name: `Connecting… attempt ${state.attempt}`,
        text: `Connecting… · attempt ${state.attempt}`,
      };
    case "disconnected":
      return {
        name: `Cannot reach the server · attempt ${state.attempt} · ${elapsed(now, state.startedAt)}`,
        text: `Cannot reach the server · attempt ${state.attempt} · ${elapsed(now, state.startedAt)}`,
      };
    case "capability-refused":
      return {
        name: "The server refused this capability",
        text: "The server refused this capability",
      };
    case "protocol-mismatch":
      return { name: "Protocol mismatch", text: "Protocol mismatch" };
    default:
      return { name: "Connection problem", text: "Connection problem" };
  }
}

function elapsed(now: number, startedAt: number): string {
  return `${Math.max(0, Math.floor((now - startedAt) / 1000))} s`;
}

const GLYPH_STATE = {
  connecting: "working",
  connected: "done",
  disconnected: "error",
  "capability-refused": "error",
  "protocol-mismatch": "error",
} as const;
