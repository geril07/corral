import { parseArgs } from "node:util";
import { startServer } from "./transport/server.ts";

const { values } = parseArgs({
  options: {
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "0" },
  },
});

const server = await startServer({ host: values.host, port: Number(values.port) });
// Parents (desktop app, tests) wait for this line to learn the URL.
console.log(`corral-server listening ${server.url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void server.close().then(() => process.exit(0)));
}
