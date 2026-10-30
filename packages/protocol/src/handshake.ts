import { z } from "zod";

/** Bumped on any wire change a peer of the other version would misread. */
export const PROTOCOL_VERSION = 1;

/**
 * Every WebSocket URL carries the client's version as `?protocol=N`. The handshake lives in
 * the URL rather than in a first message because oRPC owns every message on the RPC socket.
 */
export const PROTOCOL_QUERY_PARAM = "protocol";

/**
 * On a mismatch the server completes the upgrade and closes with this code: browsers cannot
 * read an HTTP rejection of an upgrade, but they can read a close code and reason.
 */
export const PROTOCOL_MISMATCH_CLOSE_CODE = 4001;

export const ProtocolMismatchReason = z.object({ serverProtocolVersion: z.number().int() });
export type ProtocolMismatchReason = z.infer<typeof ProtocolMismatchReason>;

/** Adds the protocol version to a server URL and a path such as `/rpc`. */
export function protocolUrl(serverUrl: string, path: string): string {
  const url = new URL(path, serverUrl);
  url.searchParams.set(PROTOCOL_QUERY_PARAM, String(PROTOCOL_VERSION));
  return url.toString();
}

/** Server side: `null` when the client speaks our version, else the close reason to send. */
export function checkProtocolVersion(url: URL): ProtocolMismatchReason | null {
  return url.searchParams.get(PROTOCOL_QUERY_PARAM) === String(PROTOCOL_VERSION)
    ? null
    : { serverProtocolVersion: PROTOCOL_VERSION };
}
