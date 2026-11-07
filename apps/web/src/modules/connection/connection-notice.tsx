import type { ConnectionState } from "@corral/client/connection-state";
import { useLayoutEffect, useState } from "react";
import { Button, Hint, StatusGlyph } from "../../common/ui/index.ts";
import { useNow } from "../../common/hooks/use-now.ts";

/**
 * The footer's connection opener. Connected shows nothing; every other state names itself, the
 * attempt and its elapsed time, and opens the recovery dialog that carries the capability
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
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <StatusGlyph state={GLYPH_STATE[state.status]} />
      <StateWord words={label.words} />
    </span>
  );
  if (onOpen === undefined) {
    return (
      <>
        {live}
        <Hint content={label.name}>
          <span
            className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground"
            aria-label={`connection: ${label.name}`}
          >
            {content}
          </span>
        </Hint>
      </>
    );
  }
  return (
    <>
      {live}
      <Hint content={label.name}>
        <Button
          variant="ghost"
          size="xs"
          layout="status"
          aria-label={`connection: ${label.name}`}
          onClick={(event) => onOpen(event.currentTarget)}
        >
          {content}
        </Button>
      </Hint>
    </>
  );
}

/**
 * The visible state word, longest first. The footer's narrowest supported row (232 px at 140 %,
 * with the config-problem icon beside it) leaves room for only a few characters, so a word that
 * would clip is replaced by the next shorter one rather than shown as an ellipsis. The full
 * sentence stays in the `Hint` and the opener's accessible name.
 */
function StateWord({ words }: { words: readonly string[] }) {
  const [element, setElement] = useState<HTMLSpanElement | null>(null);
  const [word, setWord] = useState(words[0]!);
  useLayoutEffect(() => {
    if (element === null) return undefined;
    const measure = () => {
      const width = element.clientWidth;
      if (width <= 0) return;
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (context === null) return;
      const style = getComputedStyle(element);
      context.font = style.font;
      setWord(
        words.find((candidate) => context.measureText(candidate).width <= width + 0.5) ??
          words[words.length - 1]!,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, words]);
  return (
    <span ref={setElement} data-slot="connection-state" className="min-w-0 flex-1 truncate">
      {word}
    </span>
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
): { name: string; words: readonly string[] } {
  switch (state.status) {
    case "connecting":
      return {
        name: `Connecting to the server · attempt ${state.attempt} · ${elapsed(now, state.startedAt)}`,
        words: WORD_CONNECTING,
      };
    case "disconnected":
      return {
        name: `Cannot reach the server · attempt ${state.attempt} · ${elapsed(now, state.startedAt)}`,
        words: WORD_DISCONNECTED,
      };
    case "capability-refused":
      return {
        name: `The server refused this capability · attempt ${state.attempt} · ${elapsed(now, state.startedAt)}`,
        words: WORD_REFUSED,
      };
    case "invalid-capability":
      return { name: "That capability cannot be used", words: WORD_INVALID };
    case "protocol-mismatch":
      return { name: "Protocol mismatch", words: WORD_MISMATCH };
    default:
      return { name: "Connection problem", words: WORD_PROBLEM };
  }
}

const WORD_CONNECTING = ["Connecting", "Waiting", "Wait"] as const;
const WORD_DISCONNECTED = ["Offline", "Off"] as const;
const WORD_REFUSED = ["Refused", "Deny", "No"] as const;
const WORD_INVALID = ["Invalid", "Bad"] as const;
const WORD_MISMATCH = ["Mismatch", "Wrong", "Diff"] as const;
const WORD_PROBLEM = ["Problem", "Error", "Err"] as const;

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
