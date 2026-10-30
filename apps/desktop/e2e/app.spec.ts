import { PROTOCOL_VERSION } from "@corral/protocol/handshake";
import { endpointFilePath, ServerEndpoint } from "@corral/protocol/server-endpoint";
import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

interface Fixtures {
  stateDir: string;
  launchApp: () => Promise<ElectronApplication>;
}

const test = base.extend<Fixtures>({
  // The server is detached on purpose, so each test has to stop the one it started.
  // oxlint-disable-next-line eslint/no-empty-pattern -- Playwright reads fixture dependencies from this pattern
  stateDir: async ({}, use) => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "corral-e2e-"));
    try {
      await use(stateDir);
    } finally {
      const endpoint = readEndpoint(stateDir);
      // The mismatch test points the endpoint at the test process itself.
      if (endpoint && endpoint.pid !== process.pid) killIfAlive(endpoint.pid);
      rmSync(stateDir, { recursive: true, force: true });
    }
  },
  launchApp: async ({ stateDir }, use) => {
    const apps: ElectronApplication[] = [];
    try {
      await use(async () => {
        const app = await electron.launch({
          args: [path.join(import.meta.dirname, ".."), `--user-data-dir=${stateDir}/electron`],
          env: {
            ...process.env,
            CORRAL_STATE_DIR: stateDir,
            CORRAL_DATA_DIR: `${stateDir}/data`,
            CORRAL_CONFIG_DIR: `${stateDir}/config`,
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

function readEndpoint(stateDir: string): ServerEndpoint | undefined {
  try {
    return ServerEndpoint.parse(JSON.parse(readFileSync(endpointFilePath(stateDir), "utf8")));
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
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

async function openedWindow(app: ElectronApplication) {
  const window = await app.firstWindow();
  await window.waitForURL(/[?&]server=/);
  return window;
}

// Playwright sends keys over CDP, past native menu handling, so this cannot catch the Alt
// menu-bar problem that main.ts guards against; it covers the app reacting to the prefix.
test("the window shows the app and the prefix chord arms prefix mode", async ({ launchApp }) => {
  const window = await openedWindow(await launchApp());
  await expect(window).toHaveTitle("Corral");

  await window.keyboard.press("Alt+KeyA");
  await expect(window.getByRole("status", { name: "prefix mode" })).toBeVisible();
});

test("the window is given the URL of the server the app started", async ({
  launchApp,
  stateDir,
}) => {
  const window = await openedWindow(await launchApp());

  const endpoint = readEndpoint(stateDir);
  expect(endpoint).toBeDefined();
  expect(new URL(window.url()).searchParams.get("server")).toBe(endpoint?.url);
});

test("the server outlives the app and the next launch reuses it", async ({
  launchApp,
  stateDir,
}) => {
  const first = await launchApp();
  await openedWindow(first);
  const started = readEndpoint(stateDir);
  expect(started).toBeDefined();
  const pid = started?.pid ?? 0;

  await first.close();
  expect(isAlive(pid)).toBe(true);

  const second = await launchApp();
  const window = await openedWindow(second);
  expect(readEndpoint(stateDir)?.pid).toBe(pid);
  expect(new URL(window.url()).searchParams.get("server")).toBe(started?.url);
});

test("a live server on another protocol version is reported in the window and left running", async ({
  launchApp,
  stateDir,
}) => {
  const listener = net.createServer().listen(0, "127.0.0.1");
  try {
    await new Promise((resolve) => listener.once("listening", resolve));
    const address = listener.address();
    if (address === null || typeof address === "string") throw new Error("listener has no port");
    const other: ServerEndpoint = {
      pid: process.pid,
      url: `ws://127.0.0.1:${address.port}`,
      protocolVersion: PROTOCOL_VERSION + 1,
      startedAt: 0,
    };
    writeFileSync(endpointFilePath(stateDir), JSON.stringify(other));

    const window = await (await launchApp()).firstWindow();

    await expect(window.getByRole("alert")).toContainText(
      `speaks protocol version ${PROTOCOL_VERSION + 1}`,
    );
    expect(readEndpoint(stateDir)).toEqual(other);
  } finally {
    listener.close();
  }
});
