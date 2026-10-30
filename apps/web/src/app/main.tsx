import { resolveServerTarget, SERVER_TARGET_STORAGE_KEY } from "@corral/client/bootstrap";
import { createCorralClient } from "@corral/client/corral-client";
import type { ServerTarget } from "@corral/protocol/server-target";
import type { DesktopBridge } from "@corral/protocol/desktop-bridge";
import { createRoot } from "react-dom/client";
// oxlint-disable-next-line import/no-unassigned-import -- the Tailwind entry and design tokens
import "./global.css";
import { App } from "./app.tsx";

declare global {
  interface Window {
    /** Defined by the desktop preload; absent in a plain browser. */
    corral?: DesktopBridge;
  }
}

const root = document.getElementById("root")!;
const storage = {
  read: (): unknown => {
    const raw = window.sessionStorage.getItem(SERVER_TARGET_STORAGE_KEY);
    if (raw === null) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  },
  write: (target: ServerTarget) =>
    window.sessionStorage.setItem(SERVER_TARGET_STORAGE_KEY, JSON.stringify(target)),
};

function readTarget(): Promise<ServerTarget> {
  return resolveServerTarget({
    location: window.location,
    bridge: window.corral,
    storage,
    applyHash: (hash) =>
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${hash}`,
      ),
  });
}

async function start() {
  const server = await readTarget();
  const client = createCorralClient({
    server,
    // A restarted server has a new capability. Desktop re-reads the endpoint file over IPC;
    // browser/dev re-reads the pair and a newly pasted hash bootstrap.
    refreshServer: async () => {
      try {
        return await readTarget();
      } catch {
        return undefined;
      }
    },
  });
  createRoot(root).render(<App client={client} />);
}

void start().catch((error: unknown) => {
  root.textContent = error instanceof Error ? error.message : String(error);
});
