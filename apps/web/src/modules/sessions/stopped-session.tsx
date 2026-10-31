import { describeSessionState } from "@corral/client/session-state";
import type { Session } from "@corral/protocol/rpc";
import { Button, Hint } from "../../common/ui/index.ts";
import { launchLine } from "./launch-summary.ts";

interface StoppedSessionProps {
  session: Session;
  /** The whole key press that also restarts, e.g. `alt+a r`; absent when the action is unbound. */
  restartHint: string | undefined;
  onRestart: () => void;
}

/** Shown in place of a terminal while the selected session is not running. */
export function StoppedSession({ session, restartHint, onRestart }: StoppedSessionProps) {
  const { badge, note } = describeSessionState(session);
  const launch = launchLine(session);
  return (
    <section className="max-w-md px-4 py-6" aria-label="stopped session">
      <h2 className="mb-2 text-base">
        {session.kind} · {badge}
      </h2>
      <p className="mb-3">{note}</p>
      {launch && (
        <p className="mb-3 text-muted-foreground" aria-label="launch choices">
          <Hint content={launch.details}>
            <span tabIndex={0}>{launch.text}</span>
          </Hint>
        </p>
      )}
      {session.launchError && (
        <p className="mb-3 break-words text-destructive" role="alert">
          Last start failed: {session.launchError}
        </p>
      )}
      <Button variant="default" autoFocus onClick={onRestart}>
        {session.state === "unresumable" ? "Start a new conversation" : "Start again"}
      </Button>
      {restartHint && <p className="mt-3 text-muted-foreground">Enter, or {restartHint}.</p>}
    </section>
  );
}
