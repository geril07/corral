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
  const live = (
    <span className="sr-only" role="status">
      {announcement(state)}
    </span>
  );
  const content = (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <StatusGlyph state={GLYPH_STATE[state.status]} />
      <span className="truncate">{label.text}</span>
    </span>
  );
  if (onOpen === undefined) {
    return (
      <>
        {live}
        <span
          className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground"
          aria-label={`connection: ${label.name}`}
        >
          {content}
        </span>
      </>
    );
  }
  return (
    <>
      {live}
      <Button
        variant="ghost"
        size="xs"
        layout="status"
        aria-label={`connection: ${label.name}`}
        onClick={(event) => onOpen(event.currentTarget)}
      >
        {content}
      </Button>
    </>
  );
}

/** The live-region sentence: no elapsed time, so it changes on state, not once a second. */
function announcement(state: Exclude<ConnectionState, { status: "connected" }>): string {
  switch (state.status) {
    case "connecting":
      return `Connecting to the server. Attempt ${state.attempt}.`;
    case "disconnected":
      return `Cannot reach the server. Attempt ${state.attempt}.`;
    case "capability-refused":
      return `The server refused this capability. Attempt ${state.attempt}.`;
    case "invalid-capability":
      return "That capability cannot be used.";
    case "protocol-mismatch":
      return "Protocol mismatch.";
    default:
      return "Connection problem.";
  }
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
        name: `The server refused this capability · attempt ${state.attempt} · ${elapsed(now, state.startedAt)}`,
        text: `The server refused this capability · attempt ${state.attempt} · ${elapsed(now, state.startedAt)}`,
      };
    case "invalid-capability":
      return { name: "That capability cannot be used", text: "That capability cannot be used" };
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
  "invalid-capability": "error",
  "protocol-mismatch": "error",
} as const;
