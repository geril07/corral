import { checkProtocolVersion, PROTOCOL_MISMATCH_CLOSE_CODE } from "@corral/protocol/handshake";
import { RPC_PATH } from "@corral/protocol/rpc";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

export interface RunningServer {
  readonly url: string;
  close(): Promise<void>;
}

/** Port 0 picks a free port; the chosen one is in `url`. */
export function startServer(options: { host: string; port: number }): Promise<RunningServer> {
  const http = createServer((_request, response) => response.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true });

  http.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "ws://localhost");
    if (url.pathname !== RPC_PATH) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const mismatch = checkProtocolVersion(url);
      if (mismatch) ws.close(PROTOCOL_MISMATCH_CLOSE_CODE, JSON.stringify(mismatch));
    });
  });

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, options.host, () => {
      const address = http.address();
      if (address === null || typeof address === "string")
        throw new Error(`unexpected address ${address}`);
      resolve({
        url: `ws://${options.host}:${address.port}`,
        close: () => {
          for (const client of wss.clients) client.terminate();
          http.closeAllConnections();
          return new Promise((done) => http.close(() => done()));
        },
      });
    });
  });
}
