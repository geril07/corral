import type { IssueProvider } from "@corral/protocol/rpc";

/** The URL is not a well-formed GitHub or GitLab issue URL, or carries credentials. */
export class InvalidIssueUrlError extends Error {}

/** The host could be either provider; the caller must say which one it means. */
export class IssueProviderRequiredError extends Error {
  readonly host: string;
  constructor(host: string) {
    super(`${host} is neither github.com, a ghe.com host nor gitlab.com`);
    this.host = host;
  }
}

/** The provider's CLI is not on the server's PATH. */
export class IssueCliMissingError extends Error {
  readonly command: string;
  constructor(command: string) {
    super(`${command} is not on the server's PATH`);
    this.command = command;
  }
}

/** The CLI has no usable login for the issue's host. */
export class IssueAuthRequiredError extends Error {
  readonly provider: IssueProvider;
  constructor(provider: IssueProvider) {
    super(`the server's ${provider} CLI is not authenticated`);
    this.provider = provider;
  }
}

/** The CLI did not answer within the bounded timeout. */
export class IssueFetchTimeoutError extends Error {
  readonly provider: IssueProvider;
  constructor(provider: IssueProvider) {
    super(`reading the ${provider} issue timed out`);
    this.provider = provider;
  }
}

/** The CLI answered, but not with the JSON shape its documentation promises. */
export class IssueResponseInvalidError extends Error {
  readonly provider: IssueProvider;
  constructor(provider: IssueProvider) {
    super(`the ${provider} CLI returned an unreadable issue`);
    this.provider = provider;
  }
}

/** The CLI failed for any other reason; `message` is bounded and safe to show. */
export class IssueFetchFailedError extends Error {
  readonly provider: IssueProvider;
  constructor(provider: IssueProvider, message: string) {
    super(message);
    this.provider = provider;
  }
}
