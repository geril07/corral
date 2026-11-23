import { spawn } from "node:child_process";
import { codexChatSupport } from "../agents/codex-version.ts";
import {
  recordWriter,
  releasePreviousWriter,
  releaseWriterIf,
  writerPath,
} from "../chat/writer-claim.ts";
import type { CatalogLaunch, NativeCatalog } from "./native-catalog.ts";
import { readCodexModels } from "./codex-models.ts";

/** A separate metadata app-server never opens a conversation or attaches to a session writer. */
export async function readCodexCatalog(
  launch: CatalogLaunch,
  active: Set<() => Promise<void>>,
): Promise<NativeCatalog> {
  const support = await codexChatSupport(launch.command, launch.env);
  if (!support.supported) throw new Error("unsupported Codex version");
  const path = writerPath(launch.recordDir, "codex-metadata");
  await releasePreviousWriter(path);
  const child = spawn(launch.command, ["app-server"], {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  try {
    if (child.pid !== undefined) recordWriter(path, child.pid);
  } catch (error) {
    if (child.pid !== undefined) {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // The process was already gone.
      }
    }
    throw error;
  }
  child.stderr.resume();
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (e: Error) => void }
  >();
  let id = 0;
  let buffer = "";
  let stopping: Promise<void> | undefined;
  const failed = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.stdin.on("error", () => failed(new Error("Codex metadata input failed")));
  const exited = new Promise<void>((resolve) => {
    child.once("error", () => {
      failed(new Error("Codex metadata process failed"));
      resolve();
    });
    child.once("exit", () => {
      failed(new Error("Codex metadata process exited"));
      releaseWriterIf(path, child.pid);
      resolve();
    });
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) {
      failed(new Error("Codex metadata response too large"));
      return;
    }
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const frame: unknown = JSON.parse(line);
        if (typeof frame !== "object" || frame === null || !("id" in frame)) continue;
        const record = frame as Record<string, unknown>;
        if (typeof record["id"] !== "number") continue;
        const request = pending.get(record["id"]);
        if (request === undefined) continue;
        pending.delete(record["id"]);
        if ("error" in record) request.reject(new Error("Codex metadata request failed"));
        else request.resolve(record["result"]);
      } catch {
        failed(new Error("Invalid Codex metadata response"));
      }
    }
  });
  const call = (method: string, params: object) =>
    new Promise<unknown>((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, { resolve, reject });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n",
        (error) => {
          if (error) {
            pending.delete(requestId);
            reject(new Error("Codex metadata request failed"));
          }
        },
      );
    });
  const stop = () => {
    if (stopping !== undefined) return stopping;
    stopping = (async () => {
      failed(new Error("Codex metadata stopped"));
      child.stdin.end();
      const signal = (kind: NodeJS.Signals) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          if (child.pid !== undefined && process.platform !== "win32")
            process.kill(-child.pid, kind);
          else child.kill(kind);
        } catch {
          // The metadata process already exited.
        }
      };
      signal("SIGTERM");
      const killTimer = setTimeout(() => signal("SIGKILL"), 500);
      let deadline: NodeJS.Timeout | undefined;
      try {
        const gone = await Promise.race([
          exited.then(() => true),
          new Promise<boolean>((resolve) => {
            deadline = setTimeout(() => resolve(false), 2500);
          }),
        ]);
        if (!gone) throw new Error("Codex metadata process did not stop");
      } finally {
        clearTimeout(killTimer);
        clearTimeout(deadline);
      }
    })();
    return stopping;
  };
  active.add(stop);
  const timer = setTimeout(() => failed(new Error("Codex metadata timed out")), launch.timeoutMs);
  timer.unref();
  try {
    await call("initialize", { clientInfo: { name: "corral", version: "0.1.0" } });
    const response = await call("config/read", { includeLayers: false });
    const config =
      typeof response === "object" && response !== null && "config" in response
        ? response.config
        : null;
    const reported =
      typeof config === "object" && config !== null && "model_provider" in config
        ? config.model_provider
        : null;
    // With no configured provider, 0.166.0's thread/start reports its implicit OpenAI provider.
    const provider = launch.provider ?? (typeof reported === "string" ? reported : "openai");
    const models = await readCodexModels(provider, (params) => call("model/list", params));
    return { models, partial: false };
  } finally {
    clearTimeout(timer);
    await stop();
    active.delete(stop);
  }
}
