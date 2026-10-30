import { createRequire } from "node:module";

// Electron 45 has no install script: resolving the package downloads the binary on first use.
// Parallel workers would race to download it and spawn it half-written (spawn ETXTBSY), so
// resolve it once before any worker starts.
export default function globalSetup() {
  createRequire(import.meta.url)("electron");
}
