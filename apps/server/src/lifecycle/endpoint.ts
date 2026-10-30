import { renameSync, writeFileSync } from "node:fs";
import { endpointFilePath, type ServerEndpoint } from "@corral/protocol/server-endpoint";
import { identityOf, removeIfOwned, scratchPathNextTo } from "./owned-file.ts";

export interface PublishedEndpoint {
  /** Removes the endpoint file only while it is still the one we published. */
  remove(): void;
}

/**
 * Atomic publish: write a private file, then rename it over the endpoint. The caller holds
 * the lock, so replacing a leftover endpoint of a dead server is its right.
 */
export function publishEndpoint(stateDir: string, endpoint: ServerEndpoint): PublishedEndpoint {
  const target = endpointFilePath(stateDir);
  const scratch = scratchPathNextTo(target, "endpoint");
  writeFileSync(scratch, JSON.stringify(endpoint), { flag: "wx" });
  const identity = identityOf(scratch);
  renameSync(scratch, target);
  return { remove: () => removeIfOwned(target, identity) };
}
