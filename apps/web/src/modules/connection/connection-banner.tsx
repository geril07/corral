import type { ConnectionState } from "@corral/client/connection-state";
import { useEffect, useState } from "react";
import { useNow } from "../../common/hooks/use-now.ts";
import { Button, Icon } from "../../common/ui/index.ts";
import { isDesktopHost } from "./host.ts";

/**
 * How long a reconnect may run before it becomes a notice. T3 gives an unavailable environment the
 * same grace (`ENVIRONMENT_RECONNECT_WARNING_GRACE_MS`), so a server restart does not flash a
 * banner across the working area.
 */
const RECONNECT_GRACE_MS = 2_000;

export interface ConnectionBannerProps {
  state: ConnectionState;
  /** Opens the recovery dialog; the pressed `Details` button is the opener it returns focus to. */
  onOpenDetails: (opener: HTMLElement) => void;
  /** Retries the socket now instead of waiting for the backoff. */
  onRetry: () => void;
  /** The grace for tests; production keeps the T3 interval. */
  graceMs?: number;
}

/**
 * The connection notice above the working area (`layout.md`, **Shell**). T3 keeps its sidebar for
 * work and reports an unavailable environment at the composer; this shell has one working area, so
 * the banner sits above it and serves both sidebar states. A transient reconnect waits out the
 * grace before it shows; a capability or protocol failure cannot recover on its own, so it shows
 * at once. The state word and its attempt stay visible; the full explanation is in the recovery
 * dialog behind `Details`.
 */
export function ConnectionBanner({
  state,
  onOpenDetails,
  onRetry,
  graceMs = RECONNECT_GRACE_MS,
}: ConnectionBannerProps) {
  const visible = useBannerVisible(state, graceMs);
  // Ticks the displayed attempt's elapsed time only; the live region below keeps no timer.
  const now = useNow(1000);
  if (!visible || state.status === "connected") return null;
  const content = describe(state, now);
  return (
    <div
      data-slot="connection-banner"
      data-tone={content.tone}
      className="visual-connection-banner"
    >
      <span className="visual-connection-icon">
        <Icon name={content.tone === "destructive" ? "warn" : "connection"} size="chrome" />
      </span>
      <span className="visual-connection-text">
        {content.title}
        {content.detail !== undefined && (
          <span className="visual-connection-detail"> · {content.detail}</span>
        )}
      </span>
      {canRetry(state) && (
        <Button variant="ghost" size="xs" onClick={onRetry}>
          Retry now
        </Button>
      )}
      <Button variant="ghost" size="xs" onClick={(event) => onOpenDetails(event.currentTarget)}>
        Details
      </Button>
      {/* The elapsed time changes every second; only the state change is announced. */}
      <span className="sr-only" role="status">
        {announcement(state)}
      </span>
    </div>
  );
}

/** The banner is hidden through the grace of a reconnect and shows at once for a terminal state. */
function useBannerVisible(state: ConnectionState, graceMs: number): boolean {
  const unhealthy = state.status !== "connected";
  const terminal =
    state.status !== "connected" &&
    state.status !== "connecting" &&
    state.status !== "disconnected";
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!unhealthy) return undefined;
    const timer = setTimeout(() => setHeld(true), graceMs);
    return () => {
      clearTimeout(timer);
      // A recovery ends the outage, so the next drop earns its own grace.
      setHeld(false);
    };
  }, [unhealthy, graceMs]);
  return unhealthy && (terminal || held);
}

/**
 * A retry fixes a dropped socket and, on the desktop bridge, a restarted server whose endpoint
 * file changed. A browser cannot re-read that file, so retrying a refused or invalid capability
 * would only repeat it; the capability field in the dialog is the way out.
 */
function canRetry(state: ConnectionState): boolean {
  if (state.status === "connecting") return false;
  if (state.status === "disconnected" || state.status === "protocol-mismatch") return true;
  return isDesktopHost();
}

interface BannerContent {
  tone: "attention" | "destructive";
  title: string;
  detail: string | undefined;
}

function describe(
  state: Exclude<ConnectionState, { status: "connected" }>,
  now: number,
): BannerContent {
  switch (state.status) {
    case "connecting":
      return { tone: "attention", title: "Connecting to the server", detail: attempt(state, now) };
    case "disconnected":
      return { tone: "attention", title: "Cannot reach the server", detail: attempt(state, now) };
    case "capability-refused":
      return {
        tone: "destructive",
        title: "The server refused this capability",
        detail: attempt(state, now),
      };
    case "invalid-capability":
      return { tone: "destructive", title: "That capability cannot be used", detail: undefined };
    case "protocol-mismatch":
      return {
        tone: "destructive",
        title: "This app and the server cannot talk to each other",
        detail: undefined,
      };
  }
  return { tone: "destructive", title: "Connection problem", detail: undefined };
}

function attempt(state: { attempt: number; startedAt: number }, now: number): string {
  return `Attempt ${state.attempt} · ${Math.max(0, Math.floor((now - state.startedAt) / 1000))} s`;
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
      return "This app and the server cannot talk to each other.";
  }
  return "Connection problem.";
}
