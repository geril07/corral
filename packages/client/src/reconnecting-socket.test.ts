import {
  CAPABILITY_REFUSED_CLOSE_CODE,
  PROTOCOL_MISMATCH_CLOSE_CODE,
} from "@corral/protocol/handshake";
import { expect, test, vi } from "vite-plus/test";
import type { ConnectionState } from "./connection-state.ts";
import { reconnectDelayMs, ReconnectingSocket, type CreateSocket } from "./reconnecting-socket.ts";

test("retry delays double from the initial one and stop growing at the cap", () => {
  const backoff = { initialMs: 250, maxMs: 2000 };
  expect([1, 2, 3, 4, 5, 6].map((failures) => reconnectDelayMs(failures, backoff))).toEqual([
    250, 500, 1000, 2000, 2000, 2000,
  ]);
});

/** The events ReconnectingSocket listens for; the test drives open and close explicitly. */
class FakeSocket extends EventTarget {
  binaryType: BinaryType = "blob";
  readyState = 0;

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  close(): void {
    this.readyState = 3;
  }

  fail(code: number, reason = ""): void {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code, reason }));
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const states: ConnectionState[] = [];
  const createSocket: CreateSocket = () => {
    const socket = new FakeSocket();
    sockets.push(socket);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the test drives only the events the socket listens for
    return socket as unknown as WebSocket;
  };
  const socket = new ReconnectingSocket({
    url: "ws://127.0.0.1:4100/rpc?protocol=11",
    protocols: ["corral.capability", "token"],
    backoff: { initialMs: 10, maxMs: 10 },
    createSocket,
    onState: (state) => states.push(state),
    onOpen: () => undefined,
    onClose: () => "retry",
  });
  return { socket, sockets, states };
}

test("a refused capability stops retrying and names the state", () => {
  vi.useFakeTimers();
  try {
    const { socket, sockets, states } = harness();
    expect(sockets).toHaveLength(1);
    sockets[0]?.open();
    expect(states.at(-1)).toEqual({ status: "connected" });

    sockets[0]?.fail(CAPABILITY_REFUSED_CLOSE_CODE);
    expect(states.at(-1)).toMatchObject({ status: "capability-refused", attempt: 1 });

    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1);
    expect(states.some((state) => state.status === "disconnected")).toBe(false);
    socket.close();
  } finally {
    vi.useRealTimers();
  }
});

test("a dropped socket keeps retrying, and the attempt count advances", () => {
  vi.useFakeTimers();
  try {
    const { socket, sockets, states } = harness();
    sockets[0]?.open();
    sockets[0]?.fail(1006);
    expect(states.at(-1)).toMatchObject({ status: "disconnected", attempt: 1 });

    // An abnormal close is still transient: the next attempt is scheduled and counted.
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);
    expect(states.at(-1)).toMatchObject({ status: "connecting", attempt: 2 });
    sockets[1]?.open();
    expect(states.at(-1)).toEqual({ status: "connected" });
    socket.close();
  } finally {
    vi.useRealTimers();
  }
});

test("a protocol mismatch still stops without scheduling a retry", () => {
  vi.useFakeTimers();
  try {
    const { socket, sockets, states } = harness();
    sockets[0]?.fail(PROTOCOL_MISMATCH_CLOSE_CODE, JSON.stringify({ serverProtocolVersion: 12 }));
    expect(states.at(-1)).toEqual({
      status: "protocol-mismatch",
      serverProtocolVersion: 12,
    });
    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1);
    socket.close();
  } finally {
    vi.useRealTimers();
  }
});

test("retry now opens a new attempt after a refused capability instead of waiting", () => {
  vi.useFakeTimers();
  try {
    const { socket, sockets, states } = harness();
    sockets[0]?.open();
    sockets[0]?.fail(CAPABILITY_REFUSED_CLOSE_CODE);

    socket.retry();
    expect(sockets).toHaveLength(2);
    expect(states.at(-1)).toMatchObject({ status: "connecting", attempt: 2 });
    socket.close();
  } finally {
    vi.useRealTimers();
  }
});
