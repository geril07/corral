/** A server's WebSocket base URL and the per-run capability a client must present. */
export interface ServerTarget {
  url: string;
  capability: string;
}
