import type { SessionKind } from "@corral/protocol/rpc";

export class SessionNotFoundError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`no such session: ${id}`);
    this.id = id;
  }
}

export class AlreadyRunningError extends Error {
  constructor(id: string) {
    super(`session is already running: ${id}`);
  }
}

export class AgentNotFoundError extends Error {
  readonly command: string;
  constructor(command: string) {
    super(`${command} is not on the server's PATH`);
    this.command = command;
  }
}

export class LaunchProfileUnknownError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`no usable launch profile: ${id}`);
    this.id = id;
  }
}

export class LaunchProfileKindMismatchError extends Error {
  readonly id: string;
  readonly kind: SessionKind;
  constructor(id: string, kind: SessionKind) {
    super(`launch profile ${id} does not start a ${kind} session`);
    this.id = id;
    this.kind = kind;
  }
}

export class LaunchModelUnsupportedError extends Error {
  readonly kind: SessionKind;
  constructor(kind: SessionKind) {
    super(`${kind} has no launch-time model choice`);
    this.kind = kind;
  }
}

export class LaunchModelInvalidError extends Error {
  readonly kind: SessionKind;
  constructor(kind: SessionKind) {
    super(`the model is not a valid native model id for ${kind}`);
    this.kind = kind;
  }
}
