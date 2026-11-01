import type { ChatModelRef } from "@corral/protocol/chat";
import type { AgentStatus, ChatUnavailableReason, SessionId } from "@corral/protocol/rpc";

/** Chat cannot be served for this session; `reason` is the contract's retry hint. */
export class ChatUnavailableError extends Error {
  readonly reason: ChatUnavailableReason;

  constructor(message: string, reason: ChatUnavailableReason) {
    super(message);
    this.name = "ChatUnavailableError";
    this.reason = reason;
  }
}

/** `chat.respond` named an item that is not a request still waiting for an answer. */
export class ChatRequestUnknownError extends Error {
  readonly requestId: string;

  constructor(requestId: string) {
    super(`chat request ${requestId} is not waiting for an answer`);
    this.name = "ChatRequestUnknownError";
    this.requestId = requestId;
  }
}

/** `chat.setModel` named a model the running frontend does not offer. */
export class ChatModelUnsupportedError extends Error {
  readonly model: ChatModelRef;

  constructor(model: ChatModelRef, detail: string) {
    super(detail);
    this.name = "ChatModelUnsupportedError";
    this.model = model;
  }
}

/** `chat.setReasoning` named a level the running frontend does not offer. */
export class ChatReasoningUnsupportedError extends Error {
  readonly level: string;

  constructor(level: string, detail: string) {
    super(detail);
    this.name = "ChatReasoningUnsupportedError";
    this.level = level;
  }
}

/** A chat frontend could not be started; the session keeps its row and the reason stays visible. */
export class ChatLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatLaunchError";
  }
}

/** pi answered a command with `success:false`, or the command never got an answer. */
export class PiCommandError extends Error {
  readonly command: string;

  constructor(command: string, detail: string) {
    super(`pi refused ${command}: ${detail}`);
    this.name = "PiCommandError";
    this.command = command;
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The session a chat procedure addresses, as the session service knows it. */
export interface ChatSubject {
  sessionId: SessionId;
  view: "terminal" | "chat";
  kind: "shell" | "claude" | "codex" | "pi" | "opencode";
  state: "running" | "stopped" | "unresumable";
}

/** A status with the time it was produced, which every `AgentStatus` carries. */
export function agentStatus(
  state: AgentStatus["state"],
  now: number,
  extra: { kind?: "question"; message?: string } = {},
): AgentStatus {
  return { state, updatedAt: now, ...extra };
}
