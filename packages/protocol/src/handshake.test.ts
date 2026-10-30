import { describe, expect, test } from "vite-plus/test";
import { checkProtocolVersion, PROTOCOL_VERSION, protocolUrl } from "./handshake.ts";

describe("protocol version in the URL", () => {
  test("a URL built by protocolUrl passes the server check", () => {
    const url = new URL(protocolUrl("ws://127.0.0.1:4000", "/terminals/a%2Fb"));
    expect(url.pathname).toBe("/terminals/a%2Fb");
    expect(checkProtocolVersion(url)).toBeNull();
  });

  test("another or missing version is rejected with the server's version", () => {
    for (const query of [`?protocol=${PROTOCOL_VERSION + 1}`, ""]) {
      expect(checkProtocolVersion(new URL(`ws://h/rpc${query}`))).toEqual({
        serverProtocolVersion: PROTOCOL_VERSION,
      });
    }
  });
});
