import { StatusReport, statusReportPath } from "@corral/protocol/status-report";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionService } from "../sessions/session-service.ts";

const STATUS_PATH = /^\/sessions\/([^/]+)\/status$/;
const MAX_BODY_BYTES = 16 * 1024;
const BEARER = /^Bearer (.+)$/;

/** The session id when `pathname` is a status report path. */
export function statusReportSessionId(pathname: string): string | undefined {
  const match = STATUS_PATH.exec(pathname);
  if (!match) return undefined;
  try {
    const id = decodeURIComponent(match[1]!);
    return statusReportPath(id) === pathname ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `POST /sessions/:id/status` with `Authorization: Bearer <token>`: 204 when accepted; 400 for
 * a body that is not a `StatusReport`; 401 without a bearer token; 403 for a token that is not
 * the one of the session's current launch; 404 for an unknown session; 405 and 413 as usual.
 */
export async function handleStatusReport(
  request: IncomingMessage,
  response: ServerResponse,
  sessionId: string,
  sessions: SessionService,
): Promise<void> {
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST" }).end();
    return;
  }
  const token = BEARER.exec(request.headers.authorization ?? "")?.[1];
  if (token === undefined) {
    response.writeHead(401, { "www-authenticate": "Bearer" }).end();
    return;
  }
  const body = await readBody(request);
  if (body === undefined) {
    response.writeHead(413, { connection: "close" }).end();
    return;
  }
  const report = parseReport(body);
  if (!report) {
    response.writeHead(400).end();
    return;
  }
  const outcome = sessions.reportStatus(sessionId, token, report);
  response.writeHead(outcome === "accepted" ? 204 : outcome === "forbidden" ? 403 : 404).end();
}

function parseReport(body: string): StatusReport | undefined {
  try {
    const parsed = StatusReport.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The request body, or undefined when it is larger than a status report can be. */
async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
