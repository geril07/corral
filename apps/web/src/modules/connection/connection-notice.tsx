import type { ConnectionState } from "@corral/client/connection-state";
import { PROTOCOL_VERSION } from "@corral/protocol/handshake";

export function ConnectionNotice({ state }: { state: ConnectionState }) {
  if (state.status === "protocol-mismatch") {
    return (
      <div className="mx-auto mt-24 max-w-xl px-4" role="alert">
        <h1 className="mb-2 text-lg text-danger">
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
  return (
    <>
      <p className="my-0.5 text-text-muted" role="status" aria-label="connection">
        {LABELS[state.status]}
      </p>
      {state.status === "disconnected" && window.corral === undefined ? (
        <p className="my-0.5 text-text-muted">
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
