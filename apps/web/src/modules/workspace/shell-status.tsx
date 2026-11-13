import type { ReactNode } from "react";
import { Alert, Badge, Button, IconButton, Kbd } from "../../common/ui/index.ts";
import { ConfigProblemsNotice, useConfig } from "../keymap/index.ts";

/**
 * A workspace-level message. `error` is a failed action; `notice` is guidance that asked for a
 * selection or a project. Only the failed action gets the destructive treatment.
 */
export interface ShellFailure {
  message: string;
  tone: "error" | "notice";
  /** One recoverable action, such as the discarded draft's Undo. */
  action?: { label: string; run: () => void } | undefined;
}

export interface ShellStatusProps {
  placement: "footer" | "strip";
  armed: boolean;
  /** The disarmed hint's chord; only the footer's row has room for it. */
  prefix: string;
  failure: ShellFailure | undefined;
  onDismissFailure: () => void;
  onOpenConfigProblems: (opener?: HTMLElement) => void;
  /** The footer's controls; the strip has none. */
  actions?: ReactNode;
}

/**
 * The shell's action and config status (`layout.md`, **Shell**), in the two places the pane leaves
 * it: the sidebar footer while the sidebar is shown, and a strip above the main content while it
 * is hidden. Only a failure or config problems own the strip's row; the armed-prefix badge floats
 * at the main surface's top-end, so arming the prefix never resizes the terminal.
 *
 * The connection is not here. A lost server is reported in `ConnectionBanner` above the working
 * area, where the user's work is, and serves both sidebar states (T3,
 * `useSystemComposerBanners.tsx`).
 *
 * A failed action is the kit's destructive `Alert` (`role="alert"`); guidance is a quiet
 * `role="status"`.
 */
export function ShellStatus({
  placement,
  armed,
  prefix,
  failure,
  onDismissFailure,
  onOpenConfigProblems,
  actions,
}: ShellStatusProps) {
  const { problems } = useConfig();
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
          <ConfigProblemsNotice onOpen={onOpenConfigProblems} />
          <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            {armed ? <ArmedBadge prefix={prefix} /> : <Kbd>{prefix}</Kbd>}
          </span>
        </div>
      </footer>
    );
  }
  // Only a persistent problem owns a row. Arming the prefix is transient, so its badge floats at
  // the main surface's top-end: no empty band while nothing is wrong, and no terminal resize when
  // a human-speed chord arms the prefix.
  if (failure === undefined && problems.length === 0) {
    if (!armed) return null;
    return (
      <div
        data-slot="shell-status"
        data-placement="strip"
        className="pointer-events-none absolute end-2 top-2 z-30 flex"
      >
        <ArmedBadge prefix={prefix} />
      </div>
    );
  }
  return (
    <div
      data-slot="shell-status"
      data-placement="strip"
      className={
        failure !== undefined
          ? "flex min-w-0 shrink-0 items-center gap-1 border-b border-border px-2 py-1"
          : "flex h-(--chrome-row) min-w-0 shrink-0 items-center gap-1 border-b border-border px-2"
      }
    >
      {failure !== undefined ? (
        <FailureMessage failure={failure} onDismiss={onDismissFailure} />
      ) : undefined}
      <ConfigProblemsNotice onOpen={onOpenConfigProblems} />
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
 * One failure. Its sentence wraps when the row is too narrow, and the surface grows for it: the
 * full sentence is on screen, never only in a tooltip. Dismiss sits beside the
 * message: a control at the far edge of the row reads as the surface's, not the message's.
 */
function FailureMessage({ failure, onDismiss }: { failure: ShellFailure; onDismiss: () => void }) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      {failure.tone === "error" ? (
        <Alert variant="destructive" size="compact">
          <span className="min-w-0 whitespace-pre-wrap break-words text-xs leading-tight">
            {failure.message}
          </span>
        </Alert>
      ) : (
        <p
          role="status"
          className="m-0 min-w-0 whitespace-pre-wrap break-words text-xs text-muted-foreground"
        >
          {failure.message}
        </p>
      )}
      {failure.action !== undefined && (
        <Button variant="ghost" size="xs" onClick={failure.action.run}>
          {failure.action.label}
        </Button>
      )}
      <IconButton label="Dismiss status" icon="close" size="icon-xs" onClick={onDismiss} />
      <span className="min-w-0 flex-1" />
    </div>
  );
}
