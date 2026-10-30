import { PROTOCOL_VERSION } from "@corral/protocol/handshake";
import type { ConnectionState } from "@corral/client/connection-state";

export function ConnectionNotice({ state }: { state: ConnectionState }) {
  if (state.status === "protocol-mismatch") {
    return (
      <div className="mismatch" role="alert">
        <h1>This app and the server cannot talk to each other</h1>
        <p>
          The server speaks protocol version {state.serverProtocolVersion ?? "unknown"}; this app
          speaks version {PROTOCOL_VERSION}. Update the app or restart the server with a matching
          version, then reload.
        </p>
      </div>
    );
  }
  return (
    <p className="connection" role="status" aria-label="connection">
      {LABELS[state.status]}
    </p>
  );
}

const LABELS: Record<Exclude<ConnectionState["status"], "protocol-mismatch">, string> = {
  connecting: "Connecting…",
  connected: "Connected",
  disconnected: "Disconnected. Retrying…",
};
