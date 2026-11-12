import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import os from "node:os";
import path from "node:path";
import {
  DESKTOP_OPEN_EXTERNAL_CHANNEL,
  DESKTOP_SERVER_CHANNEL,
} from "@corral/protocol/desktop-bridge";
import { externalUrl } from "@corral/protocol/external-url";
import { resolveStateDir } from "@corral/protocol/server-endpoint";
import { currentServerTarget, ensureServer } from "./server-connection.ts";
import { errorPageUrl } from "./window-pages.ts";
import { isAppNavigation } from "./external-links.ts";
import { openExternalRequest } from "./bridge.ts";

// No application menu: on Linux and Windows a lone Alt would otherwise reveal the menu bar
// and swallow Alt chords such as the default prefix (docs/design.md, Keyboard).
Menu.setApplicationMenu(null);

const webDist = path.join(import.meta.dirname, "../../web/dist/index.html");
const serverEntry = path.join(import.meta.dirname, "../../server/src/main.ts");
const preload = path.join(import.meta.dirname, "preload.cjs");
const SERVER_START_TIMEOUT_MS = 15_000;
// `docs/layout.md`: desktop support begins at 1024×640. The window and its starting size
// share the floor, so neither the start nor a later resize can drop below it.
const MIN_WINDOW_WIDTH = 1024;
const MIN_WINDOW_HEIGHT = 640;
const DEFAULT_WINDOW_WIDTH = 1280;
const DEFAULT_WINDOW_HEIGHT = 800;

const stateDir = resolveStateDir(process.env, os.homedir());
let mainWindow: BrowserWindow | undefined;
// The page asks for this after it loads; the capability never enters the page URL. Only the
// trusted top frame of our window gets an answer, never a popup or a sub-frame. Read the
// endpoint every time: a server restart rotates the capability.
ipcMain.handle(DESKTOP_SERVER_CHANNEL, async (event) => {
  if (
    mainWindow === undefined ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    return null;
  }
  return (await currentServerTarget(stateDir)) ?? null;
});
// A link in chat asks for the OS browser instead of loading in this window. Same trusted-frame rule:
// a pop-up or sub-frame gets nothing, and the URL is re-validated before it leaves the app.
ipcMain.handle(DESKTOP_OPEN_EXTERNAL_CHANNEL, (event, value: unknown) => {
  if (
    mainWindow === undefined ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    return;
  }
  openExternalRequest(value, { openExternal: (url) => openExternal(url) });
});

async function openWindow() {
  const window = new BrowserWindow({
    width: Math.max(MIN_WINDOW_WIDTH, DEFAULT_WINDOW_WIDTH),
    height: Math.max(MIN_WINDOW_HEIGHT, DEFAULT_WINDOW_HEIGHT),
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: "Corral",
    webPreferences: { preload },
  });
  mainWindow = window;
  // The preload bridge belongs to the local app only: internal reloads stay, everything else
  // is prevented and, when it is an ordinary web link, handed to the OS browser instead.
  window.webContents.on("will-navigate", (event, url) => {
    if (isAppNavigation(window.webContents.getURL(), url)) return;
    event.preventDefault();
    openExternal(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  const connection = await ensureServer({
    stateDir,
    serverEntry,
    startTimeoutMs: SERVER_START_TIMEOUT_MS,
  });
  if (connection.status !== "ready") {
    await window.loadURL(errorPageUrl(connection));
    return;
  }
  const devUrl = process.env.CORRAL_WEB_URL;
  if (devUrl) {
    const url = new URL(devUrl);
    url.searchParams.set("server", connection.server.url);
    await window.loadURL(url.toString());
  } else {
    await window.loadFile(webDist, { query: { server: connection.server.url } });
  }
}

function openExternal(value: string): void {
  const url = externalUrl(value);
  if (url !== undefined) void shell.openExternal(url).catch(() => undefined);
}

// Not top-level await: Playwright's Electron loader hangs on an entry that awaits at the top.
void app.whenReady().then(openWindow);
// Quitting leaves the server running: it is detached and owned by nobody here.
app.on("window-all-closed", () => app.quit());
