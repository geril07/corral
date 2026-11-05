import { PROTOCOL_VERSION } from "@corral/protocol/handshake";
import { endpointFilePath, ServerEndpoint } from "@corral/protocol/server-endpoint";
import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
} from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { addProject, createRepo, createTask, sessionTabs, workspace } from "./app-helpers.ts";

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
            SHELL: "/bin/sh",
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

function windowSize(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getSize());
}

// Playwright sends keys over CDP, past native menu handling, so this cannot catch the Alt
// menu-bar problem that main.ts guards against; it covers the app reacting to the prefix.
test("the window shows the app and the prefix chord arms prefix mode", async ({ launchApp }) => {
  const window = await openedWindow(await launchApp());
  await expect(window).toHaveTitle("Corral");

  await window.keyboard.press("Alt+KeyA");
  await expect(window.getByRole("status", { name: "prefix mode" })).toBeVisible();
});

test("the window and the sidebar keep the 1024×640 floor", async ({ launchApp }) => {
  const app = await launchApp();
  const window = await openedWindow(app);
  const separator = window.getByRole("separator", { name: "Resize sidebar" });
  await expect(separator).toBeVisible();

  // The host refuses a smaller size; the web layout sees 1024 and leaves the main area 640.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(800, 600);
  });
  await expect.poll(() => windowSize(app)).toEqual([1024, 640]);
  await expect.poll(() => window.evaluate<number>("window.innerWidth")).toBe(1024);
  await expect(separator).toHaveAttribute("aria-valuemax", "384");
  // The launch default may have been the 1280 px window's; reset at 1024 names the narrow one.
  await separator.dblclick();
  await expect(separator).toHaveAttribute("aria-valuenow", "232");

  // The edge stops at 208 and 384, and the main area is exactly its reserve at the maximum.
  // oxlint-disable-next-line eslint/no-await-in-loop -- each press must land on the new width
  for (let press = 0; press < 20; press += 1) await separator.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", "384");
  expect(await window.locator("main").evaluate((main) => main.getBoundingClientRect().width)).toBe(
    640,
  );
  await separator.press("ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", "368");
  await separator.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", "384");
  await separator.press("ArrowRight");
  await expect(separator).toHaveAttribute("aria-valuenow", "384");
  // oxlint-disable-next-line eslint/no-await-in-loop -- each press must land on the new width
  for (let press = 0; press < 20; press += 1) await separator.press("ArrowLeft");
  await expect(separator).toHaveAttribute("aria-valuenow", "208");

  // Double-click resets to the narrow default at the supported floor. The 1920 px default is
  // covered in Browser Mode, where a pretend window width cannot be retiled by the compositor.
  await separator.dblclick();
  await expect(separator).toHaveAttribute("aria-valuenow", "232");
});

test("the window is given the URL of the server the app started, and the capability only over IPC", async ({
  launchApp,
  stateDir,
}) => {
  const window = await openedWindow(await launchApp());

  const endpoint = readEndpoint(stateDir);
  expect(endpoint).toBeDefined();
  expect(new URL(window.url()).searchParams.get("server")).toBe(endpoint?.url);
  expect(window.url()).not.toContain(endpoint?.capability);
  expect(
    await window.evaluate<{ url: string; capability: string }>("window.corral.server()"),
  ).toEqual({ url: endpoint?.url, capability: endpoint?.capability });
  const log = readFileSync(path.join(stateDir, "server.log"), "utf8");
  expect(log).not.toContain(endpoint?.capability);

  // The preload bridge is for the trusted top frame only; a document inside an iframe has none.
  const frameBridge = await window.evaluate<string>(
    `new Promise((resolve) => {
      const frame = document.createElement("iframe");
      frame.srcdoc = '<script>parent.postMessage(typeof window.corral, "*")<\\/script>';
      window.addEventListener("message", (event) => resolve(event.data), { once: true });
      document.body.append(frame);
    })`,
  );
  expect(frameBridge).toBe("undefined");
});

test("a reload reconnects through the preload bridge and keeps the hash route", async ({
  launchApp,
}) => {
  const window = await openedWindow(await launchApp());
  const nav = window.getByRole("navigation", { name: "workspace" });
  await expect(window.getByText("Add a repository to start")).toBeVisible();
  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyC");
  await expect(nav.getByRole("button", { name: /^sh · / })).toHaveCount(1);

  await window.evaluate("window.location.hash = '#/board'");
  await expect(window).toHaveURL(/#\/board$/);
  await expect(window.getByRole("region", { name: "Board" })).toBeVisible();
  await window.reload();
  await window.waitForURL(/[?&]server=/);

  await expect(window).toHaveURL(/#\/board$/);
  await expect(window.getByRole("region", { name: "Board" })).toBeVisible();
  // Back on the workspace after the reload, the terminal list comes from the reconnected RPC.
  await window.evaluate("window.location.hash = '#/'");
  await expect(window.getByRole("region", { name: "Board" })).toBeHidden();
  await expect(nav.getByRole("button", { name: /^sh · / })).toHaveCount(1);
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

function startServer(stateDir: string): void {
  const child = spawn(
    process.execPath,
    [path.join(import.meta.dirname, "../../server/src/main.ts")],
    {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        CORRAL_STATE_DIR: stateDir,
        CORRAL_DATA_DIR: `${stateDir}/data`,
        CORRAL_CONFIG_DIR: `${stateDir}/config`,
        SHELL: "/bin/sh",
      },
    },
  );
  child.unref();
}

test("a server restart with a new capability reconnects without quitting the app", async ({
  launchApp,
  stateDir,
}) => {
  const repo = createRepo(stateDir);
  const window = await openedWindow(await launchApp());
  await expect(window.getByText("Add a repository to start")).toBeVisible();
  await addProject(window, repo);
  await createTask(window, "Survives restart");
  const selectedTask = workspace(window).getByRole("button", { name: /^Survives restart/ });
  await expect(selectedTask).toHaveAttribute("aria-current", "true");

  const before = readEndpoint(stateDir);
  const oldPid = before?.pid ?? 0;
  const oldCapability = before?.capability;
  expect(oldCapability).toBeDefined();
  process.kill(oldPid, "SIGKILL");
  await expect.poll(() => isAlive(oldPid), { timeout: 5_000 }).toBe(false);

  startServer(stateDir);
  await expect
    .poll(
      () => {
        const current = readEndpoint(stateDir);
        return current !== undefined && current.pid !== oldPid ? current.capability : undefined;
      },
      { timeout: 20_000 },
    )
    .not.toBe(oldCapability);

  // The footer only shows connection state while it is not connected.
  await expect(window.getByRole("status", { name: /^connection:/ })).toHaveCount(0);
  await expect(selectedTask).toHaveAttribute("aria-current", "true");

  const shells = sessionTabs(window).getByRole("tab", { name: /^shell(?: \d+)?$/ });
  const beforeCount = await shells.count();
  await window.keyboard.press("Alt+KeyA");
  await window.keyboard.press("KeyC");
  await expect(shells).toHaveCount(beforeCount + 1);
  await window.keyboard.type("echo after-restart-$((4*5))");
  await window.keyboard.press("Enter");
  await expect
    .poll(() => window.evaluate<string>('window.corralScreenText?.() ?? ""'))
    .toContain("after-restart-20");
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
      capability: "another-server-capability",
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
