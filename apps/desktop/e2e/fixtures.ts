import { endpointFilePath, ServerEndpoint } from "@corral/protocol/server-endpoint";
import { _electron as electron, test as base, type ElectronApplication } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
    try {
      await use(async () => {
        const app = await electron.launch({
          args: [path.join(import.meta.dirname, ".."), `--user-data-dir=${stateDir}/electron`],
          // A plain sh keeps the prompt of terminals created without a command predictable. The
          // fake agents (apps/server/test/fake-agents) come first on PATH so that no test can start
          // a real agent, and CODEX_HOME and CLAUDE_CONFIG_DIR keep the real ~/.codex and ~/.claude out of reach.
          env: {
            ...process.env,
            CORRAL_STATE_DIR: stateDir,
            CORRAL_DATA_DIR: `${stateDir}/data`,
            SHELL: "/bin/sh",
            PATH: `${FAKE_AGENTS_BIN}${path.delimiter}${process.env["PATH"] ?? ""}`,
            CODEX_HOME: `${stateDir}/codex`,
            CLAUDE_CONFIG_DIR: `${stateDir}/claude`,
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
