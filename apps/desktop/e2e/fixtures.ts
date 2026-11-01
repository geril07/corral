import { endpointFilePath, ServerEndpoint } from "@corral/protocol/server-endpoint";
import { _electron as electron, test as base, type ElectronApplication } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFakeIssueCliBin } from "../../web/test/issue-clis.ts";

const FAKE_AGENTS_BIN = path.join(import.meta.dirname, "../../server/test/fake-agents/bin");

interface Fixtures {
  stateDir: string;
  launchApp: () => Promise<ElectronApplication>;
}

/** Each test gets its own state directory, hence its own server, which the test stops at the end. */
export const test = base.extend<Fixtures>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Playwright reads fixture dependencies from this pattern
  stateDir: async ({}, use) => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "corral-e2e-"));
    try {
      await use(stateDir);
    } finally {
      const endpoint = readEndpoint(stateDir);
      if (endpoint) killIfAlive(endpoint.pid);
      rmSync(stateDir, { recursive: true, force: true });
    }
  },
  launchApp: async ({ stateDir }, use) => {
    const apps: ElectronApplication[] = [];
    const issueBin = path.join(stateDir, "issue-clis");
    createFakeIssueCliBin(issueBin);
    try {
      await use(async () => {
        const app = await electron.launch({
          args: [path.join(import.meta.dirname, ".."), `--user-data-dir=${stateDir}/electron`],
          // A plain sh keeps the prompt of terminals created without a command predictable. The
          // fake agents (apps/server/test/fake-agents) come first on PATH so that no test can start
          // a real agent, and CODEX_HOME, CLAUDE_CONFIG_DIR and OPENCODE_CONFIG_DIR keep the real ~/.codex,
          // ~/.claude and ~/.config/opencode out of reach. A blank OPENCODE_CONFIG_CONTENT hides a developer's own
          // inline config, which would stop the server from loading its status plugin.
          env: {
            ...process.env,
            CORRAL_STATE_DIR: stateDir,
            CORRAL_DATA_DIR: `${stateDir}/data`,
            CORRAL_CONFIG_DIR: `${stateDir}/config`,
            SHELL: "/bin/sh",
            PATH: `${issueBin}${path.delimiter}${FAKE_AGENTS_BIN}${path.delimiter}${process.env["PATH"] ?? ""}`,
            CODEX_HOME: `${stateDir}/codex`,
            CLAUDE_CONFIG_DIR: `${stateDir}/claude`,
            OPENCODE_CONFIG_DIR: `${stateDir}/opencode`,
            OPENCODE_CONFIG_CONTENT: "",
            FAKE_AGENT_LOG: launchLog(stateDir),
            // The fake pi's RPC journal, one file per agent session id: a resumed frontend rebuilds
            // its history from here, exactly as pi's own session store does. Per test, so no run
            // inherits another's conversation.
            FAKE_PI_RPC_HOME: piRpcHome(stateDir),
            FAKE_ISSUE_LOG: issueLaunchLog(stateDir),
            FAKE_ISSUE_RESPONSE_FILE: issueResponseFile(stateDir),
            FAKE_ISSUE_MODE: "ok",
          },
        });
        apps.push(app);
        return app;
      });
    } finally {
      await Promise.all(apps.map((app) => app.close().catch(() => undefined)));
    }
  },
});

/** Where the fake agents append one JSON line per launch (apps/server/test/fake-agents). */
export const launchLog = (stateDir: string) => path.join(stateDir, "launches.jsonl");

/** Where the fake pi in RPC mode keeps its session journals (apps/server/test/fake-agents). */
export const piRpcHome = (stateDir: string) => path.join(stateDir, "pi-rpc");

/** The conversation the fake pi wrote for one agent session id, oldest message first. */
export function readPiJournal(
  stateDir: string,
  agentSessionId: string,
): { role: string; content: unknown }[] {
  try {
    const file = path.join(
      piRpcHome(stateDir),
      `${agentSessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`,
    );
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed)
      ? parsed.filter(
          (message: unknown): message is { role: string; content: unknown } =>
            message !== null &&
            typeof message === "object" &&
            typeof Reflect.get(message, "role") === "string",
        )
      : [];
  } catch {
    return [];
  }
}

/**
 * The fake pi's overlap marker for one agent session id: written only if a second frontend started
 * while the previous one was still alive. A handoff must never leave one behind.
 */
export function readPiOverlap(
  stateDir: string,
  agentSessionId: string,
): { previous: number; pid: number } | undefined {
  try {
    const file = path.join(
      piRpcHome(stateDir),
      `${agentSessionId.replace(/[^A-Za-z0-9._-]/g, "_")}.overlap.json`,
    );
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object"
      ? {
          previous: Number(Reflect.get(parsed, "previous")),
          pid: Number(Reflect.get(parsed, "pid")),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Where the fake gh/glab append one JSON line per launch (apps/web/test/issue-clis.ts). */
export const issueLaunchLog = (stateDir: string) => path.join(stateDir, "issue-launches.jsonl");

/** The JSON the fake gh/glab answer with; the test writes it before Import. */
export const issueResponseFile = (stateDir: string) => path.join(stateDir, "issue-response.json");

export interface AgentLaunch {
  agent: string;
  argv: string[];
  pid: number;
  env: { CORRAL_SESSION_ID?: string };
}

export function readLaunches(stateDir: string): AgentLaunch[] {
  try {
    return readFileSync(launchLog(stateDir), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line): AgentLaunch => JSON.parse(line));
  } catch {
    return [];
  }
}

export function readEndpoint(stateDir: string): ServerEndpoint | undefined {
  try {
    return ServerEndpoint.parse(JSON.parse(readFileSync(endpointFilePath(stateDir), "utf8")));
  } catch {
    return undefined;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killIfAlive(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}
