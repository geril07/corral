import { PROTOCOL_VERSION } from "@corral/protocol/handshake";
import type { ServerConnection } from "./server-connection.ts";

type ServerProblem = Exclude<ServerConnection, { status: "ready" }>;

function message(problem: ServerProblem): string {
  return problem.status === "protocol-mismatch"
    ? `The running Corral server (pid ${problem.pid}) speaks protocol version ${problem.serverProtocolVersion}, but this app speaks version ${PROTOCOL_VERSION}. Stop that server and start the app again. It was left running, so its sessions are untouched.`
    : problem.message;
}

/** A self-contained page for `loadURL`, so errors need no web bundle. */
export function errorPageUrl(problem: ServerProblem): string {
  const escaped = message(problem).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  const html = `<!doctype html><meta charset="utf-8"><title>Corral</title>
<body style="font: 16px system-ui; background: #1e1e1e; color: #ddd; padding: 2em">
<h1>Corral cannot use the server</h1><p role="alert">${escaped}</p>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
