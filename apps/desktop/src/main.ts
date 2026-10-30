import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import os from "node:os";
import path from "node:path";
import { DESKTOP_SERVER_CHANNEL } from "@corral/protocol/desktop-bridge";
import { resolveStateDir } from "@corral/protocol/server-endpoint";
import { currentServerTarget, ensureServer } from "./server-connection.ts";
import { errorPageUrl } from "./window-pages.ts";
import { externalUrl, isAppNavigation } from "./external-links.ts";

// No application menu: on Linux and Windows a lone Alt would otherwise reveal the menu bar
// and swallow Alt chords such as the default prefix (docs/design.md, Keyboard).
Menu.setApplicationMenu(null);

const webDist = path.join(import.meta.dirname, "../../web/dist/index.html");
const serverEntry = path.join(import.meta.dirname, "../../server/src/main.ts");
const preload = path.join(import.meta.dirname, "preload.cjs");
const SERVER_START_TIMEOUT_MS = 15_000;

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

async function openWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
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
