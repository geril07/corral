import { expect, test } from "vite-plus/test";
import { CreateTaskInput, MAX_TASK_PROMPT } from "./rpc.ts";

const utf8 = (text: string) => new TextEncoder().encode(text).length;
const creating = (prompt: string) => ({
  projectId: "p",
  prompt,
  workspace: { type: "main-worktree" as const },
});

test("a task prompt is capped by its UTF-8 bytes, not by its characters", () => {
  // 32 000 characters, 64 000 UTF-16 units — under the old character count — but 128 000 bytes of
  // UTF-8: an astral character costs four, and the argv limit the cap protects counts bytes.
  const astral = "🚀".repeat(32_000);
  expect(astral.length).toBeLessThan(MAX_TASK_PROMPT);
  expect(utf8(astral)).toBeGreaterThan(MAX_TASK_PROMPT);

  const refused = CreateTaskInput.safeParse(creating(astral));

  expect(refused.success).toBe(false);
  expect(refused.error?.issues[0]?.message).toContain(`${MAX_TASK_PROMPT} bytes`);
});

test("a prompt up to the byte limit is accepted, one byte over is not, and padding does not count", () => {
  const atLimit = "a".repeat(MAX_TASK_PROMPT);

  expect(CreateTaskInput.safeParse(creating(atLimit)).success).toBe(true);
  expect(CreateTaskInput.safeParse(creating(`${atLimit}a`)).success).toBe(false);
  // Trimmed before the check: the spaces are gone, so the same prompt still fits.
  expect(CreateTaskInput.safeParse(creating(`  ${atLimit}  `)).success).toBe(true);

  // Two bytes per character: half as many characters reach the same limit.
  const twoByte = "é".repeat(MAX_TASK_PROMPT / 2);
  expect(utf8(twoByte)).toBe(MAX_TASK_PROMPT);
  expect(CreateTaskInput.safeParse(creating(twoByte)).success).toBe(true);
  expect(CreateTaskInput.safeParse(creating(`${twoByte}é`)).success).toBe(false);
});
