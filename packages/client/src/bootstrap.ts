import type { DesktopBridge } from "@corral/protocol/desktop-bridge";
import type { ServerTarget } from "@corral/protocol/server-target";
import { resolveServerUrl, type PageLocation } from "./server-url.ts";

/** Query parameter inside the hash route that carries a capability on a first load. */
export const CAPABILITY_HASH_PARAM = "capability";

/** Session storage key that keeps the server URL and capability paired across reloads. */
export const SERVER_TARGET_STORAGE_KEY = "corral.server-target";

export interface ServerTargetStorage {
  /** Untrusted JSON from session storage; `resolveServerTarget` validates it. */
  read(): unknown;
  write(target: ServerTarget): void;
}

export interface ResolveServerTargetOptions {
  location: PageLocation & { hash: string };
  /** Present in the desktop app; its endpoint comes from the owner-only endpoint file. */
  bridge?: DesktopBridge | undefined;
  /** Browser/dev only: keeps the URL and capability paired without putting them in a request URL. */
  storage?: ServerTargetStorage | undefined;
  /** Browser/dev only: removes the capability from the visible hash before the router starts. */
  applyHash?: ((hash: string) => void) | undefined;
}

/**
 * Where this page connects and which capability it presents. Desktop mode uses the preload
 * bridge. Browser/dev mode takes an explicit capability from `#/route?capability=...`, stores
 * the target for reloads and strips it from the route. A stored capability is only reused for
 * the same server URL; an explicit new capability replaces the pair. A page with neither fails
 * instead of opening an unauthenticated socket or sending a token to another server.
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

  const url = resolveServerUrl(options.location);
  const fromHash = takeCapabilityFromHash(options.location.hash);
  if (fromHash.capability !== undefined) {
    if (fromHash.capability.length === 0) {
      throw new Error(
        "The server capability in the URL is empty. Open this page with the capability from endpoint.json.",
      );
    }
    const target = { url, capability: fromHash.capability };
    options.storage?.write(target);
    options.applyHash?.(fromHash.hash);
    return target;
  }

  const stored = options.storage?.read();
  if (!isServerTarget(stored)) {
    throw new Error(
      "No server capability. Start Corral from the desktop app, or open this page with " +
        `#/route?${CAPABILITY_HASH_PARAM}=<capability from endpoint.json>.`,
    );
  }
  if (stored.url !== url) {
    // Never offer a stored capability to a server the user was redirected to.
    throw new Error(
      `The saved capability belongs to ${stored.url}, not ${url}. Open this page with that ` +
        `server's #/route?${CAPABILITY_HASH_PARAM}=<capability from endpoint.json>.`,
    );
  }
  return stored;
}

export function isServerTarget(value: unknown): value is ServerTarget {
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
