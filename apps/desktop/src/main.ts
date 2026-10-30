import { app, BrowserWindow, Menu } from "electron";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "@corral/protocol/server-endpoint";
import { ensureServer } from "./server-connection.ts";
import { errorPageUrl } from "./window-pages.ts";

// No application menu: on Linux and Windows a lone Alt would otherwise reveal the menu bar
// and swallow Alt chords such as the default prefix (docs/design.md, Keyboard).
Menu.setApplicationMenu(null);

const webDist = path.join(import.meta.dirname, "../../web/dist/index.html");
const serverEntry = path.join(import.meta.dirname, "../../server/src/main.ts");
const SERVER_START_TIMEOUT_MS = 15_000;

async function openWindow() {
  const window = new BrowserWindow({ width: 1280, height: 800, title: "Corral" });
  const connection = await ensureServer({
    stateDir: resolveStateDir(process.env, os.homedir()),
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
    url.searchParams.set("server", connection.url);
    await window.loadURL(url.toString());
  } else {
    await window.loadFile(webDist, { query: { server: connection.url } });
  }
}

// Not top-level await: Playwright's Electron loader hangs on an entry that awaits at the top.
void app.whenReady().then(openWindow);
// Quitting leaves the server running: it is detached and owned by nobody here.
app.on("window-all-closed", () => app.quit());
