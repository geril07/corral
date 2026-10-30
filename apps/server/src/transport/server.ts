import { answerHello, ClientHello } from "@corral/protocol/handshake";
import { WebSocketServer, type RawData } from "ws";

export interface RunningServer {
  readonly url: string;
  close(): Promise<void>;
}

/** Port 0 picks a free port; the chosen one is in `url`. */
export function startServer(options: { host: string; port: number }): Promise<RunningServer> {
  const wss = new WebSocketServer({ host: options.host, port: options.port });
  wss.on("connection", (socket) => {
    socket.once("message", (data) => {
      const hello = ClientHello.safeParse(JSON.parse(decodeText(data)));
      if (!hello.success) return socket.close(1002, "expected hello");
      const reply = answerHello(hello.data);
      socket.send(JSON.stringify(reply));
      if (reply.type === "rejected") socket.close(1008, reply.reason);
    });
  });
  return new Promise((resolve, reject) => {
    wss.once("error", reject);
    wss.once("listening", () => {
      const address = wss.address();
      if (address === null || typeof address === "string")
        throw new Error(`unexpected address ${address}`);
      resolve({
        url: `ws://${options.host}:${address.port}`,
        close: () => {
          for (const client of wss.clients) client.terminate();
          return new Promise((done) => wss.close(() => done()));
        },
      });
    });
  });
}

function decodeText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString("utf8");
  return data.toString("utf8");
}
