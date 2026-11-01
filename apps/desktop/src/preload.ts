import { contextBridge, ipcRenderer } from "electron";
import {
  DESKTOP_OPEN_EXTERNAL_CHANNEL,
  DESKTOP_SERVER_CHANNEL,
  type DesktopBridge,
} from "@corral/protocol/desktop-bridge";

/** The only things the page may ask the shell for: where the server is, and an OS browser tab. */
const bridge: DesktopBridge = {
  server: () => ipcRenderer.invoke(DESKTOP_SERVER_CHANNEL),
  openExternal: (url: string) => ipcRenderer.invoke(DESKTOP_OPEN_EXTERNAL_CHANNEL, url),
};

contextBridge.exposeInMainWorld("corral", bridge);
