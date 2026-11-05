export type ConnectionState =
  /** An attempt is in flight; `attempt` counts from the first one, `startedAt` is epoch ms. */
  | { status: "connecting"; attempt: number; startedAt: number }
  | { status: "connected" }
  /** The socket dropped or could not open; a retry is scheduled. */
  | { status: "disconnected"; attempt: number; startedAt: number }
  /** The server refused the presented capability. Retrying it cannot help. */
  | { status: "capability-refused"; attempt: number; startedAt: number }
  /** The browser could not construct a socket for this target, e.g. a malformed capability. */
  | { status: "invalid-capability"; detail: string }
  /** The server speaks another protocol version. Retrying cannot help, so the client stops. */
  | { status: "protocol-mismatch"; serverProtocolVersion: number | undefined };
