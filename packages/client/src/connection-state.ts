export type ConnectionState =
  | { status: "connecting" }
  | { status: "connected" }
  /** The socket dropped or could not open; a retry is scheduled. */
  | { status: "disconnected" }
  /** The server speaks another protocol version. Retrying cannot help, so the client stops. */
  | { status: "protocol-mismatch"; serverProtocolVersion: number | undefined };
