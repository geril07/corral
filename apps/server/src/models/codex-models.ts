import type { ChatModel } from "@corral/protocol/chat";
import { z } from "zod";

const NativePage = z.object({
  data: z
    .array(
      z.object({
        model: z.string().min(1).max(512),
        displayName: z.string().max(1024),
        hidden: z.boolean(),
        defaultReasoningEffort: z.string().min(1).max(128),
        supportedReasoningEfforts: z
          .array(z.object({ reasoningEffort: z.string().min(1).max(128) }))
          .max(128),
      }),
    )
    .max(1000),
  nextCursor: z.string().min(1).max(1024).nullable().optional(),
});

export type CodexModel = ChatModel & { defaultReasoningEffort: string };

/** The server's model slug is the value `turn/start` accepts; its separate id is not that contract. */
export async function readCodexModels(
  provider: string | null,
  request: (params: { cursor?: string }) => Promise<unknown>,
): Promise<CodexModel[]> {
  const models: CodexModel[] = [];
  const seenCursors = new Set<string>();
  const seenModels = new Set<string>();
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
    // oxlint-disable-next-line no-await-in-loop -- each native cursor names the next page
    const page = NativePage.parse(await request(cursor === undefined ? {} : { cursor }));
    for (const entry of page.data) {
      if (entry.hidden) continue;
      if (seenModels.has(entry.model)) throw new Error("duplicate Codex model");
      seenModels.add(entry.model);
      models.push({
        provider,
        id: entry.model,
        name: entry.displayName || entry.model,
        reasoningLevels: entry.supportedReasoningEfforts.map((option) => option.reasoningEffort),
        defaultReasoningEffort: entry.defaultReasoningEffort,
      });
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor === undefined) return models;
    if (seenCursors.has(cursor)) throw new Error("repeated Codex model cursor");
    seenCursors.add(cursor);
  }
  throw new Error("Codex model list exceeded its page limit");
}
