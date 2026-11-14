import { describeSessionState } from "@corral/client/session-state";
import type { Session } from "@corral/protocol/rpc";
import { Button } from "../../common/ui/index.ts";
import { statusMessage } from "../status/index.ts";

interface StoppedSessionProps {
  session: Session;
  onRestart: () => void;
}

/** Shown in place of a terminal while the selected session is not running. */
export function StoppedSession({ session, onRestart }: StoppedSessionProps) {
  const { badge, action } = describeSessionState(session);
  return (
    <section className="max-w-md px-4 py-6" aria-label={`${badge} session`}>
      <h2 className="mb-2 text-base font-semibold">
        {session.kind} · {badge}
      </h2>
      {session.launchError ? (
        <p className="mb-3 break-words text-destructive" role="alert">
          Last start failed: {session.launchError}
        </p>
      ) : session.status?.state === "error" ? (
        <p className="mb-3 break-words text-destructive" role="alert">
          {statusMessage(session.status)}
        </p>
      ) : undefined}
      <Button variant="default" autoFocus onClick={onRestart}>
        {action}
      </Button>
    </section>
  );
}
