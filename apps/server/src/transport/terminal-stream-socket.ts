import {
  ClientTerminalMessage,
  TERMINAL_NOT_FOUND_CLOSE_CODE,
  type ServerTerminalMessage,
} from "@corral/protocol/terminal-stream";
import { WebSocket, type RawData } from "ws";
import type { TerminalSession } from "../terminals/terminal-session.ts";

const NORMAL_CLOSE = 1000;
const POLICY_VIOLATION_CLOSE = 1008;

/** Speaks the terminal stream protocol over `ws` for one attached client. */
export function serveTerminalStream(ws: WebSocket, session: TerminalSession | undefined): void {
  if (!session) {
    ws.close(TERMINAL_NOT_FOUND_CLOSE_CODE);
    return;
  }

  const sendMessage = (message: ServerTerminalMessage) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const attachment = session.attach({
    snapshot: (size, data) => sendMessage({ type: "snapshot", size, data }),
    output: (bytes) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(bytes, { binary: true });
    },
    resized: (size) => sendMessage({ type: "resized", size }),
    exit: (exit) => {
      sendMessage({ type: "exit", exit });
      ws.close(NORMAL_CLOSE);
    },
    terminalClosed: () => ws.close(TERMINAL_NOT_FOUND_CLOSE_CODE),
  });

  ws.on("message", (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      attachment.input(toBytes(data));
      return;
    }
    const message = parseClientMessage(new TextDecoder().decode(toBytes(data)));
    if (!message) {
      ws.close(POLICY_VIOLATION_CLOSE, "invalid message");
    } else if (message.type === "resize") {
      attachment.resize(message.size);
    } else {
      attachment.ack(message.bytes);
    }
  });
  ws.on("close", () => attachment.detach());
}

function parseClientMessage(text: string): ClientTerminalMessage | undefined {
  try {
    const parsed = ClientTerminalMessage.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}
