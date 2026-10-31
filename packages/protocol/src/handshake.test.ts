import { describe, expect, test } from "vite-plus/test";
import {
  CAPABILITY_SUBPROTOCOL,
  capabilityFromProtocols,
  capabilityProtocols,
  checkProtocolVersion,
  PROTOCOL_VERSION,
  protocolUrl,
} from "./handshake.ts";

describe("protocol version in the URL", () => {
  test("a URL built by protocolUrl passes the server check", () => {
    const url = new URL(protocolUrl("ws://127.0.0.1:4000", "/terminals/a%2Fb"));
    expect(url.pathname).toBe("/terminals/a%2Fb");
    expect(checkProtocolVersion(url)).toBeNull();
  });

  test("the release barrier is version 6 and version 5 is rejected", () => {
    expect(PROTOCOL_VERSION).toBe(6);
    expect(checkProtocolVersion(new URL("ws://h/rpc?protocol=5"))).toEqual({
      serverProtocolVersion: 6,
    });
  });

  test("another or missing version is rejected with the server's version", () => {
    for (const query of [`?protocol=${PROTOCOL_VERSION + 1}`, ""]) {
      expect(checkProtocolVersion(new URL(`ws://h/rpc${query}`))).toEqual({
        serverProtocolVersion: PROTOCOL_VERSION,
      });
    }
  });

  test("the capability is never put in the URL", () => {
    const url = protocolUrl("ws://127.0.0.1:4000", "/rpc");
    expect(url).toBe(`ws://127.0.0.1:4000/rpc?protocol=${PROTOCOL_VERSION}`);
  });
});

describe("capability subprotocol", () => {
  test("offers a marker followed by the token", () => {
    expect(capabilityProtocols("secret")).toEqual([CAPABILITY_SUBPROTOCOL, "secret"]);
    expect(capabilityFromProtocols(capabilityProtocols("secret"))).toBe("secret");
  });

  test("a missing marker or a marker without a token yields no capability", () => {
    expect(capabilityFromProtocols([])).toBeUndefined();
    expect(capabilityFromProtocols(["secret"])).toBeUndefined();
    expect(capabilityFromProtocols([CAPABILITY_SUBPROTOCOL])).toBeUndefined();
  });

  test("an empty capability is refused instead of opening an unauthenticated socket", () => {
    expect(() => capabilityProtocols("")).toThrow("server capability is empty");
  });
});
