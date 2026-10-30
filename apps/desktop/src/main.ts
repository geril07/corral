import { app, BrowserWindow, Menu } from "electron";
import path from "node:path";

// No application menu: on Linux and Windows a lone Alt would otherwise reveal the menu bar
// and swallow Alt chords such as the default prefix (docs/design.md, Keyboard).
Menu.setApplicationMenu(null);

const webDist = path.join(import.meta.dirname, "../../web/dist/index.html");

async function openWindow() {
  const window = new BrowserWindow({ width: 1280, height: 800, title: "Corral" });
  const devUrl = process.env.CORRAL_WEB_URL;
  await (devUrl ? window.loadURL(devUrl) : window.loadFile(webDist));
}

// Not top-level await: Playwright's Electron loader hangs on an entry that awaits at the top.
void app.whenReady().then(openWindow);
app.on("window-all-closed", () => app.quit());
