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
