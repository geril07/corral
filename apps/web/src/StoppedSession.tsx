import { describeSessionState } from "@corral/client/session-state";
import type { Session } from "@corral/protocol/rpc";

interface StoppedSessionProps {
  session: Session;
  prefix: string;
  onRestart: () => void;
}

/** Shown in place of a terminal while the selected session is not running. */
export function StoppedSession({ session, prefix, onRestart }: StoppedSessionProps) {
  const { badge, note } = describeSessionState(session);
  return (
    <section className="stopped-session" aria-label="stopped session">
      <h2>
        {session.kind} · {badge}
      </h2>
      <p>{note}</p>
      <button type="button" autoFocus onClick={onRestart}>
        {session.state === "unresumable" ? "Start a new conversation" : "Start again"}
      </button>
      <p className="hint">Enter, or {prefix} then r.</p>
    </section>
  );
}
