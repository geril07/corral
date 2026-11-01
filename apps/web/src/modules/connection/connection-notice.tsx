import type { ConnectionState } from "@corral/client/connection-state";
import { PROTOCOL_VERSION } from "@corral/protocol/handshake";
import { StatusGlyph } from "../../common/ui/index.ts";

export function ConnectionNotice({ state }: { state: ConnectionState }) {
  if (state.status === "protocol-mismatch") {
    return (
      <div className="mx-auto mt-24 max-w-xl px-4" role="alert">
        <h1 className="mb-2 text-lg text-destructive">
          This app and the server cannot talk to each other
        </h1>
        <p>
          The server speaks protocol version {state.serverProtocolVersion ?? "unknown"}; this app
          speaks version {PROTOCOL_VERSION}. Update the app or restart the server with a matching
          version, then reload.
        </p>
      </div>
    );
  }
  // The sidebar footer carries the little status there is: only an unconnected state shows
  // (`layout.md`, **Sidebar** footer).
  if (state.status === "connected") return null;
  return (
    <>
      <span
        className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground"
        role="status"
        aria-label={`connection: ${LABELS[state.status]}`}
      >
        <StatusGlyph state={GLYPH_STATE[state.status]} />
        {LABELS[state.status]}
      </span>
      {state.status === "disconnected" && window.corral === undefined ? (
        <p className="my-0.5 text-muted-foreground">
          If the server restarted, open this page with the new capability from endpoint.json.
        </p>
      ) : null}
    </>
  );
}

const LABELS: Record<Exclude<ConnectionState["status"], "protocol-mismatch">, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  disconnected: "Disconnected. Retrying…",
};

const GLYPH_STATE = {
  connecting: "working",
  connected: "done",
  disconnected: "error",
} as const;
