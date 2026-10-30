import type { DesktopBridge } from "@corral/protocol/desktop-bridge";
import type { ServerTarget } from "@corral/protocol/server-target";
import { resolveServerUrl, type PageLocation } from "./server-url.ts";

/** Query parameter inside the hash route that carries a capability on a first load. */
export const CAPABILITY_HASH_PARAM = "capability";

/** Session storage key that keeps the capability across reloads in one browser tab. */
export const CAPABILITY_STORAGE_KEY = "corral.capability";

export interface CapabilityStorage {
  read(): string | undefined;
  write(capability: string): void;
}

export interface ResolveServerTargetOptions {
  location: PageLocation & { hash: string };
  /** Present in the desktop app; its endpoint comes from the owner-only endpoint file. */
  bridge?: DesktopBridge | undefined;
  /** Browser/dev only: keeps the capability across reloads without putting it in a request URL. */
  storage?: CapabilityStorage | undefined;
  /** Browser/dev only: removes the capability from the visible hash before the router starts. */
  applyHash?: ((hash: string) => void) | undefined;
}

/**
 * Where this page connects and which capability it presents. Desktop mode uses the preload
 * bridge. Browser/dev mode takes an explicit capability from `#/route?capability=...`, stores
 * it for reloads and strips it from the route. A page with neither fails instead of opening an
 * unauthenticated socket.
 */
export async function resolveServerTarget(
  options: ResolveServerTargetOptions,
): Promise<ServerTarget> {
  if (options.bridge) {
    const target = await options.bridge.server();
    if (!isServerTarget(target)) {
      throw new Error("The desktop app did not provide a usable server endpoint.");
    }
    return target;
  }

  const fromHash = takeCapabilityFromHash(options.location.hash);
  if (fromHash.capability !== undefined) {
    options.storage?.write(fromHash.capability);
    options.applyHash?.(fromHash.hash);
  }
  const capability = fromHash.capability ?? options.storage?.read();
  if (capability === undefined || capability.length === 0) {
    throw new Error(
      "No server capability. Start Corral from the desktop app, or open this page with " +
        `#/route?${CAPABILITY_HASH_PARAM}=<capability from endpoint.json>.`,
    );
  }
  return { url: resolveServerUrl(options.location), capability };
}

function isServerTarget(value: unknown): value is ServerTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    "url" in value &&
    typeof value.url === "string" &&
    "capability" in value &&
    typeof value.capability === "string" &&
    value.capability.length > 0
  );
}

/**
 * Hash history owns everything after `#`, so the capability is a query parameter of the route
 * rather than a second fragment. It is removed before the router sees the route.
 */
function takeCapabilityFromHash(hash: string): {
  capability?: string;
  hash: string;
} {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryAt = raw.indexOf("?");
  if (queryAt === -1) return { hash };
  const route = raw.slice(0, queryAt) || "/";
  const params = new URLSearchParams(raw.slice(queryAt + 1));
  const capability = params.get(CAPABILITY_HASH_PARAM) ?? undefined;
  if (capability === undefined) return { hash };
  params.delete(CAPABILITY_HASH_PARAM);
  const query = params.toString();
  return { capability, hash: `#${route}${query.length > 0 ? `?${query}` : ""}` };
}
