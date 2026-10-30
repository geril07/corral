import type { IssueProvider, TaskSource } from "@corral/protocol/rpc";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  IssueAuthRequiredError,
  IssueCliMissingError,
  IssueFetchFailedError,
  IssueFetchTimeoutError,
} from "./errors.ts";
import { parseIssueOutput } from "./issue-output.ts";
import { parseIssueUrl, type IssueRef } from "./issue-url.ts";

export const DEFAULT_ISSUE_TIMEOUT_MS = 10_000;
const MAX_ISSUE_TIMEOUT_MS = 60_000;
const MIN_ISSUE_TIMEOUT_MS = 50;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_CHARS = 400;

/** A read-only issue lookup through the server host's own `gh` or `glab` login. */
export class IssueImportService {
  readonly #timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    this.#timeoutMs = clampTimeout(options.timeoutMs ?? DEFAULT_ISSUE_TIMEOUT_MS);
  }

  async resolve(
    projectPath: string,
    input: { url: string; provider?: IssueProvider | undefined },
    signal?: AbortSignal,
  ): Promise<TaskSource> {
    const ref = parseIssueUrl(input.url, input.provider);
    const { command, args } = readCommand(ref);
    const stdout = await runReadOnlyCommand({
      command,
      args,
      cwd: projectPath,
      timeoutMs: this.#timeoutMs,
      provider: ref.provider,
      signal,
    });
    return parseIssueOutput(ref.provider, stdout, ref, Date.now());
  }
}

/** Reads the timeout override once at server start; tests set it to keep timeouts short. */
export function issueImportTimeoutMs(env: NodeJS.ProcessEnv): number {
  const value = Number(env["CORRAL_ISSUE_IMPORT_TIMEOUT_MS"]);
  return Number.isFinite(value) && value > 0 ? clampTimeout(value) : DEFAULT_ISSUE_TIMEOUT_MS;
}

function clampTimeout(value: number): number {
  return Math.min(Math.max(Math.floor(value), MIN_ISSUE_TIMEOUT_MS), MAX_ISSUE_TIMEOUT_MS);
}

function readCommand(ref: IssueRef): { command: string; args: string[] } {
  if (ref.provider === "github") {
    return {
      command: "gh",
      args: [
        "issue",
        "view",
        ref.url,
        `--repo=${ref.host}/${ref.repository}`,
        "--json=number,title,body",
      ],
    };
  }
  return { command: "glab", args: ["issue", "view", ref.url, "--output=json"] };
}

function runReadOnlyCommand(options: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  provider: IssueProvider;
  signal: AbortSignal | undefined;
}): Promise<string> {
  const { command, args, cwd, timeoutMs, provider, signal } = options;
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });

    execFile(
      command,
      args,
      {
        cwd,
        // Nothing may wait for a prompt, a pager or an update check.
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: "1",
          GH_NO_UPDATE_NOTIFIER: "1",
          GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
          GH_PAGER: "cat",
          GLAB_NO_PROMPT: "1",
          GLAB_CHECK_UPDATE: "false",
          GLAB_PAGER: "cat",
          NO_COLOR: "1",
          CLICOLOR: "0",
        },
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        killSignal: "SIGKILL",
        signal: controller.signal,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (!error) {
          resolve(stdout);
          return;
        }
        if (timedOut) {
          reject(new IssueFetchTimeoutError(provider));
          return;
        }
        if (signal?.aborted) {
          reject(error);
          return;
        }
        if (error.code === "ENOENT") {
          reject(
            existsSync(cwd) ? new IssueCliMissingError(command) : missingDirectory(provider, cwd),
          );
          return;
        }
        if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(new IssueFetchFailedError(provider, "The issue tool returned too much output."));
          return;
        }
        const exitCode = typeof error.code === "number" ? error.code : undefined;
        const message = boundedCliMessage(stderr || error.message);
        reject(
          isAuthFailure(provider, exitCode, message)
            ? new IssueAuthRequiredError(provider)
            : new IssueFetchFailedError(provider, message),
        );
      },
    );
  });
}

function missingDirectory(provider: IssueProvider, cwd: string): IssueFetchFailedError {
  return new IssueFetchFailedError(provider, `The project directory is gone: ${cwd}`);
}

function isAuthFailure(
  provider: IssueProvider,
  exitCode: number | undefined,
  message: string,
): boolean {
  if (provider === "github") {
    // `gh help exit-codes`: 4 is "requires authentication".
    return (
      exitCode === 4 || /gh auth login|authentication required|not logged in|401/i.test(message)
    );
  }
  return /glab auth login|authentication required|not logged in|401|no token|authenticated host/i.test(
    message,
  );
}

/** CLI text can be long or coloured; the UI gets one bounded line. */
function boundedCliMessage(text: string): string {
  const clean = text
    // oxlint-disable-next-line no-control-regex -- stripping the ESC that starts ANSI colour is the point
    .replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (clean || "The issue tool failed.").slice(0, MAX_ERROR_CHARS);
}
