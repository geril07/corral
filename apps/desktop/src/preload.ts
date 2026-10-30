import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_SERVER_CHANNEL, type DesktopBridge } from "@corral/protocol/desktop-bridge";

/** The only thing the page may ask the shell for: where the server is and how to authenticate. */
const bridge: DesktopBridge = {
  server: () => ipcRenderer.invoke(DESKTOP_SERVER_CHANNEL),
};

contextBridge.exposeInMainWorld("corral", bridge);
