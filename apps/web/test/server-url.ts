import type { ServerTarget } from "@corral/protocol/server-target";
import { inject } from "vite-plus/test";
import { SERVER_TARGET_KEY } from "./server-url-key.ts";

/** The real server started by `real-server.ts`, with the capability every client must present. */
export function serverTarget(): ServerTarget {
  // See real-server.ts: the key is typed `never`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const target: unknown = inject(SERVER_TARGET_KEY as never);
  if (!isServerTarget(target)) throw new Error("the browser test global setup did not run");
  return target;
}

function isServerTarget(value: unknown): value is ServerTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    "url" in value &&
    typeof value.url === "string" &&
    "capability" in value &&
    typeof value.capability === "string"
  );
}
