import { describeSessionState } from "@corral/client/session-state";
import type { Session } from "@corral/protocol/rpc";
import { Button } from "../../common/ui/index.ts";

interface StoppedSessionProps {
  session: Session;
  prefix: string;
  onRestart: () => void;
}

/** Shown in place of a terminal while the selected session is not running. */
export function StoppedSession({ session, prefix, onRestart }: StoppedSessionProps) {
  const { badge, note } = describeSessionState(session);
  return (
    <section className="max-w-md px-4 py-6" aria-label="stopped session">
      <h2 className="mb-2 text-base">
        {session.kind} · {badge}
      </h2>
      <p className="mb-3">{note}</p>
      <Button variant="primary" autoFocus onClick={onRestart}>
        {session.state === "unresumable" ? "Start a new conversation" : "Start again"}
      </Button>
      <p className="mt-3 text-text-muted">Enter, or {prefix} then r.</p>
    </section>
  );
}
