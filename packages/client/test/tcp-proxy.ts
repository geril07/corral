import net from "node:net";

export interface TcpProxyOptions {
  target: { host: string; port: number };
  /** Rewrites the first bytes a client sends on each connection (the HTTP upgrade request). */
  rewriteRequest?: (head: string) => string;
}

/** A TCP pipe in front of the server, so tests can cut connections the way a network does. */
export class TcpProxy {
  readonly #server: net.Server;
  readonly #sockets = new Set<net.Socket>();
  #refusing = false;
  #accepted = 0;

  private constructor(server: net.Server) {
    this.#server = server;
  }

  static async start(options: TcpProxyOptions): Promise<TcpProxy> {
    const server: net.Server = net.createServer();
    const proxy = new TcpProxy(server);
    server.on("connection", (client) => proxy.#accept(client, options));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return proxy;
  }

  get url(): string {
    const address = this.#server.address();
    if (address === null || typeof address === "string") throw new Error("proxy is not listening");
    return `ws://127.0.0.1:${address.port}`;
  }

  /** Connections accepted so far, refused ones excluded. */
  get accepted(): number {
    return this.#accepted;
  }

  /** Cuts every open connection. New ones still get through unless `refuse` is on. */
  drop(): void {
    for (const socket of this.#sockets) socket.destroy();
  }

  /** While on, new connections are closed at once, like a server that is down. */
  refuse(on: boolean): void {
    this.#refusing = on;
  }

  async close(): Promise<void> {
    this.drop();
    await new Promise((resolve) => this.#server.close(resolve));
  }

  #accept(client: net.Socket, options: TcpProxyOptions): void {
    if (this.#refusing) {
      client.destroy();
      return;
    }
    this.#accepted += 1;
    const upstream = net.connect(options.target.port, options.target.host);
    for (const socket of [client, upstream]) {
      this.#sockets.add(socket);
      socket.on("error", () => undefined);
      socket.on("close", () => {
        this.#sockets.delete(socket);
        (socket === client ? upstream : client).destroy();
      });
    }
    let firstChunk = true;
    client.on("data", (chunk: Buffer) => {
      if (firstChunk && options.rewriteRequest) {
        upstream.write(options.rewriteRequest(chunk.toString("latin1")), "latin1");
      } else {
        upstream.write(chunk);
      }
      firstChunk = false;
    });
    upstream.pipe(client);
  }
}
