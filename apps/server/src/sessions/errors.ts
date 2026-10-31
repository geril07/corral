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

export class LaunchProfileRevisionWithoutProfileError extends Error {
  constructor() {
    super("a profile revision needs a selected profile");
  }
}

export class LaunchProfileChangedError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`launch profile ${id} changed since it was selected`);
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

/** A shell runs no agent, so there is nothing to put a prompt into. */
export class ShellPromptError extends Error {
  constructor() {
    super("a shell session takes no prompt");
  }
}

/**
 * A failure outside the launch contract (node-pty could not spawn, a resource limit). The
 * diagnostic is already redacted against the launch's referenced values; the message shown to
 * clients is its first line.
 */
export class LaunchSpawnError extends Error {
  readonly kind: SessionKind;
  readonly diagnostic: string;
  readonly summary: string;
  constructor(kind: SessionKind, diagnostic: string) {
    super("the session could not be launched");
    this.kind = kind;
    this.diagnostic = diagnostic;
    this.summary = diagnostic.split("\n", 1)[0] ?? "the session could not be launched";
  }
}
