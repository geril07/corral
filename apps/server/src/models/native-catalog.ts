/* oxlint-disable no-await-in-loop -- native startup snapshots must be read serially until stable or timed out */
import type { ChatModel } from "@corral/protocol/chat";
import type { AgentKind } from "@corral/protocol/config";
import { z } from "zod";
import { join } from "node:path";
import { PiDriver } from "../chat/pi-driver.ts";
import { ChatTimeline } from "../chat/timeline.ts";
import { OpenCodeServers } from "../chat/opencode-server.ts";
import {
  recordWriter,
  releasePreviousWriter,
  releaseWriter,
  writerPath,
} from "../chat/writer-claim.ts";
import { pi } from "../agents/pi.ts";
import { setTimeout as delay } from "node:timers/promises";
import { boundedJson } from "./catalog-json.ts";

export interface CatalogLaunch {
  kind: AgentKind;
  command: string;
  cwd: string;
  env: Record<string, string>;
  model: string | null;
  provider: string | null;
  recordDir: string;
  timeoutMs: number;
}
export interface NativeCatalog {
  models: ChatModel[];
  partial: boolean;
}

const OpenCodeModels = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      providerID: z.string().min(1),
      name: z.string(),
      enabled: z.boolean(),
    }),
  ),
});

/** Own metadata runtimes, never the shared OpenCode server or a working chat's pi child. */
export async function readNativeCatalog(
  launch: CatalogLaunch,
  active: Set<() => Promise<void>>,
): Promise<NativeCatalog> {
  if (launch.kind === "pi") {
    const path = writerPath(launch.recordDir, "pi");
    await releasePreviousWriter(path);
    const driver = new PiDriver({
      ...launch,
      sessionId: "metadata",
      timeline: new ChatTimeline(),
      args: ["--mode", "rpc", "--no-session", ...pi.launchArgs(launch.model, launch.provider)],
      how: "start",
      agentSessionId: null,
      prompt: null,
      readyTimeoutMs: launch.timeoutMs,
      exitGraceMs: 500,
      dialogTimeoutMs: launch.timeoutMs,
      writer: { record: (pid) => recordWriter(path, pid), release: () => releaseWriter(path) },
      onStatus: () => undefined,
      onExit: () => undefined,
    });
    const stop = () => driver.stop();
    active.add(stop);
    try {
      driver.start();
      await driver.whenReady();
      return { models: [...driver.state.models], partial: false };
    } finally {
      await stop();
      active.delete(stop);
    }
  }
  const deadline = Date.now() + launch.timeoutMs;
  const pool = new OpenCodeServers({
    dataDir: join(launch.recordDir, "opencode"),
    readyTimeoutMs: launch.timeoutMs,
    exitGraceMs: 500,
  });
  const stop = () => pool.closeAll();
  active.add(stop);
  try {
    const address = await pool.acquire("metadata", launch);
    let previous: string | undefined;
    let latest: ChatModel[] = [];
    for (;;) {
      try {
        const url = new URL("/api/model", address.url);
        url.searchParams.set("location[directory]", launch.cwd);
        const response = await fetch(url, {
          headers: {
            authorization:
              "Basic " + Buffer.from("opencode:" + address.password).toString("base64"),
          },
          signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });
        if (!response.ok) throw new Error("model list unavailable");
        const data = OpenCodeModels.parse(await boundedJson(response));
        const models = data.data
          .filter((m) => m.enabled)
          .map((m) => ({ provider: m.providerID, id: m.id, name: m.name }));
        const fingerprint = JSON.stringify(models);
        latest = models.length > 0 ? models : latest;
        if (models.length > 0 && fingerprint === previous) return { models, partial: false };
        previous = fingerprint;
      } catch (error) {
        if (latest.length === 0) throw error;
        return { models: latest, partial: true };
      }
      if (Date.now() + 250 >= deadline) return { models: latest, partial: true };
      // Poll a changing startup snapshot to a bounded deadline; equality is the observable signal.
      await delay(250);
    }
  } finally {
    await stop();
    active.delete(stop);
  }
}
