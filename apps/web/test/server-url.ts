import { inject } from "vite-plus/test";
import { SERVER_URL_KEY } from "./server-url-key.ts";

/** URL of the real server started by `real-server.ts`. */
export function serverUrl(): string {
  // See real-server.ts: the key is typed `never`.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const url: unknown = inject(SERVER_URL_KEY as never);
  if (typeof url !== "string") throw new Error("the browser test global setup did not run");
  return url;
}
