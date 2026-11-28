import { expect, test } from "vite-plus/test";
import { readCodexModels } from "./codex-models.ts";

test("Codex model pages preserve the native slug, offered efforts and default", async () => {
  const calls: unknown[] = [];
  const models = await readCodexModels("work", async (input) => {
    calls.push(input);
    return input.cursor === undefined
      ? {
          data: [
            {
              id: "display-id",
              model: "native-slug",
              displayName: "Native",
              hidden: false,
              defaultReasoningEffort: "medium",
              supportedReasoningEfforts: [
                { reasoningEffort: "low" },
                { reasoningEffort: "medium" },
              ],
            },
          ],
          nextCursor: "second",
        }
      : { data: [], nextCursor: null };
  });
  expect(calls).toEqual([{}, { cursor: "second" }]);
  expect(models).toEqual([
    {
      id: "native-slug",
      provider: "work",
      name: "Native",
      reasoningLevels: ["low", "medium"],
      defaultReasoningEffort: "medium",
    },
  ]);
});

test("Codex discovery refuses cyclic pages and does not turn malformed data into an empty list", async () => {
  await expect(
    readCodexModels(null, async () => ({ data: [], nextCursor: "same" })),
  ).rejects.toThrow("repeated Codex model cursor");
  await expect(readCodexModels(null, async () => ({ data: [{}] }))).rejects.toBeInstanceOf(Error);
});
