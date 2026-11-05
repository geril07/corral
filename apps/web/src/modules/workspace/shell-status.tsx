import type { ConnectionState } from "@corral/client/connection-state";
import type { ReactNode } from "react";
import { Alert, Badge, Hint, IconButton, Kbd, useTruncatedText } from "../../common/ui/index.ts";
import { ConnectionNotice } from "../connection/index.ts";
import { ConfigProblemsNotice, useConfig } from "../keymap/index.ts";

/**
 * A workspace-level message. `error` is a failed action; `notice` is guidance that asked for a
 * selection or a project. Only the failed action gets the destructive treatment.
 */
export interface ShellFailure {
  message: string;
  tone: "error" | "notice";
}

export interface ShellStatusProps {
  placement: "footer" | "strip";
  connection: ConnectionState;
  armed: boolean;
  /** The disarmed hint's chord; only the footer's row has room for it. */
  prefix: string;
  failure: ShellFailure | undefined;
  onDismissFailure: () => void;
  onOpenConnection: (opener: HTMLElement) => void;
  onOpenConfigProblems: (opener?: HTMLElement) => void;
  /** The footer's controls; the strip has none. */
  actions?: ReactNode;
}

/**
 * The shell's one status surface (`layout.md`, **Shell**), in the two places the pane leaves it:
 * the sidebar footer while the sidebar is shown, and a strip above the main content while it is
 * hidden. The strip keeps its row whether or not it has something to say, so arming the prefix
 * never resizes the terminal under it; the footer's row exists for the same reason.
 *
 * The connection status is A2's opener (`Button layout="status"`), so a browser tab whose
 * capability rotated still reaches the `endpoint.json` guidance in the recovery dialog. A failed
 * action is the kit's destructive `Alert` (`role="alert"`); guidance is a quiet `role="status"`.
 */
export function ShellStatus({
  placement,
  connection,
  armed,
  prefix,
  failure,
  onDismissFailure,
  onOpenConnection,
  onOpenConfigProblems,
  actions,
}: ShellStatusProps) {
  const { problems } = useConfig();
  const status = (
    <>
      <ConnectionNotice state={connection} onOpen={onOpenConnection} />
      <ConfigProblemsNotice onOpen={onOpenConfigProblems} />
    </>
  );
  if (placement === "footer") {
    return (
      <footer
        data-slot="shell-status"
        data-placement="footer"
        className="shrink-0 border-t border-border"
      >
        {failure !== undefined && (
          <div className="border-b border-border px-2 py-1">
            <FailureMessage failure={failure} onDismiss={onDismissFailure} />
          </div>
        )}
        <div className="flex h-9 min-w-0 items-center gap-0.5 px-2">
          {actions}
          {status}
          <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            {armed ? <ArmedBadge prefix={prefix} /> : <Kbd>{prefix}</Kbd>}
          </span>
        </div>
      </footer>
    );
  }
  // The strip is mounted for the whole hidden state, even with nothing to say: a surface that
  // appeared with the armed badge would resize the terminal on every human-speed chord.
  const hasContent =
    failure !== undefined || connection.status !== "connected" || problems.length > 0 || armed;
  return (
    <div
      data-slot="shell-status"
      data-placement="strip"
      className={
        hasContent
          ? "flex h-(--chrome-row) min-w-0 shrink-0 items-center gap-1 border-b border-border px-2"
          : "flex h-(--chrome-row) min-w-0 shrink-0 items-center gap-1 px-2"
      }
    >
      {failure !== undefined ? (
        <FailureMessage failure={failure} onDismiss={onDismissFailure} />
      ) : undefined}
      {status}
      {armed && (
        <span className="ml-auto flex shrink-0">
          <ArmedBadge prefix={prefix} />
        </span>
      )}
    </div>
  );
}

/**
 * The armed prefix, named for a screen reader and identical in both placements. The primary chip
 * reads as armed rather than as the disarmed hint, while naming the chord the next key completes.
 */
function ArmedBadge({ prefix }: { prefix: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1" role="status" aria-label="prefix mode">
      <Badge variant="default" size="compact">
        {prefix}
      </Badge>
    </span>
  );
}

/**
 * One failure, with the full sentence on the truncated span's tooltip. Dismiss sits beside the
 * message: a control at the far edge of the row reads as the surface's, not the message's.
 */
function FailureMessage({ failure, onDismiss }: { failure: ShellFailure; onDismiss: () => void }) {
  const { observe, clipped } = useTruncatedText(failure.message);
  const text = (
    <span ref={observe} className="min-w-0 truncate" title={clipped ? failure.message : undefined}>
      {failure.message}
    </span>
  );
  const message = clipped ? <Hint content={failure.message}>{text}</Hint> : text;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      {failure.tone === "error" ? (
        <Alert variant="destructive" size="compact">
          {message}
        </Alert>
      ) : (
        <p role="status" className="m-0 min-w-0 truncate text-xs text-muted-foreground">
          {message}
        </p>
      )}
      <IconButton label="Dismiss status" icon="close" size="icon-xs" onClick={onDismiss} />
      <span className="min-w-0 flex-1" />
    </div>
  );
}
