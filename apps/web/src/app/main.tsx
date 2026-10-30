import { createCorralClient } from "@corral/client/corral-client";
import { resolveServerUrl } from "@corral/client/server-url";
import { createRoot } from "react-dom/client";
// oxlint-disable-next-line import/no-unassigned-import -- the Tailwind entry and design tokens
import "./global.css";
import { App } from "./app.tsx";

const root = document.getElementById("root")!;
try {
  const client = createCorralClient({ serverUrl: resolveServerUrl(window.location) });
  createRoot(root).render(<App client={client} />);
} catch (error) {
  root.textContent = error instanceof Error ? error.message : String(error);
}
