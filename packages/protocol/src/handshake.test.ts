import { describe, expect, test } from "vite-plus/test";
import { answerHello, PROTOCOL_VERSION } from "./handshake.ts";

describe("answerHello", () => {
  test("welcomes a client on the same protocol version", () => {
    expect(answerHello({ type: "hello", protocolVersion: PROTOCOL_VERSION })).toEqual({
      type: "welcome",
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  test("rejects a client on another version and names the server's version", () => {
    expect(answerHello({ type: "hello", protocolVersion: PROTOCOL_VERSION + 1 })).toEqual({
      type: "rejected",
      reason: "protocol-mismatch",
      serverProtocolVersion: PROTOCOL_VERSION,
    });
  });
});
