import { CAPABILITY_STORAGE_KEY, resolveServerTarget } from "@corral/client/bootstrap";
import { createCorralClient } from "@corral/client/corral-client";
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

async function start() {
  const server = await resolveServerTarget({
    location: window.location,
    bridge: window.corral,
    storage: {
      read: () => window.sessionStorage.getItem(CAPABILITY_STORAGE_KEY) ?? undefined,
      write: (capability) => window.sessionStorage.setItem(CAPABILITY_STORAGE_KEY, capability),
    },
    applyHash: (hash) =>
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${hash}`,
      ),
  });
  const client = createCorralClient({ server });
  createRoot(root).render(<App client={client} />);
}

void start().catch((error: unknown) => {
  root.textContent = error instanceof Error ? error.message : String(error);
});
