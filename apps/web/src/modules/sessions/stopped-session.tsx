import { describeSessionState } from "@corral/client/session-state";
import type { Session, Task } from "@corral/protocol/rpc";
import { Button, Hint } from "../../common/ui/index.ts";
import { statusMessage } from "../status/index.ts";
import { launchLine } from "./launch-summary.ts";

interface StoppedSessionProps {
  session: Session;
  /** The task's state, so a settled task's action says what it does to the task. */
  taskState?: Task["state"] | undefined;
  /** The whole key press that also restarts, e.g. `alt+a r`; absent when the action is unbound. */
  restartHint: string | undefined;
  onRestart: () => void;
}

/** Shown in place of a terminal while the selected session is not running. */
export function StoppedSession({
  session,
  taskState,
  restartHint,
  onRestart,
}: StoppedSessionProps) {
  const { badge, action, note } = describeSessionState(session);
  const launch = launchLine(session);
  return (
    <section className="max-w-md px-4 py-6" aria-label={`${badge} session`}>
      <h2 className="mb-2 text-base font-semibold">
        {session.kind} · {badge}
      </h2>
      <p className="mb-3">{note}</p>
      {taskState === "settled" && (
        <p className="mb-3 text-muted-foreground">
          This task is settled. Restarting makes the task active and resumes the sessions that were
          running.
        </p>
      )}
      {launch && (
        <p className="mb-3 text-muted-foreground" aria-label="launch choices">
          <Hint content={launch.details}>
            <span tabIndex={0}>{launch.text}</span>
          </Hint>
        </p>
      )}
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
      {restartHint && <p className="mt-3 text-muted-foreground">Enter, or {restartHint}.</p>}
    </section>
  );
}
