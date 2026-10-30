import { PROTOCOL_VERSION, ServerHello, type ClientHello } from "@corral/protocol/handshake";

export type ConnectResult =
  | { ok: true; socket: WebSocket }
  | { ok: false; reason: "protocol-mismatch"; serverProtocolVersion: number }
  | { ok: false; reason: "unreachable" };

/** Opens a socket and completes the version handshake before handing it out. */
export function connect(url: string): Promise<ConnectResult> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      const hello: ClientHello = { type: "hello", protocolVersion: PROTOCOL_VERSION };
      socket.send(JSON.stringify(hello));
    });
    socket.addEventListener("error", () => resolve({ ok: false, reason: "unreachable" }));
    socket.addEventListener(
      "message",
      (event) => {
        const reply = ServerHello.parse(JSON.parse(String(event.data)));
        if (reply.type === "welcome") return resolve({ ok: true, socket });
        socket.close();
        resolve({
          ok: false,
          reason: reply.reason,
          serverProtocolVersion: reply.serverProtocolVersion,
        });
      },
      { once: true },
    );
  });
}
