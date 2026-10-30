import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { writeClaudeTranscript } from "../../test/claude-transcripts.ts";
import { claude } from "./claude.ts";

const ID = "11111111-2222-4333-8444-555555555555";
let configDir: string;
beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "corral-claude-"));
});
afterEach(() => rmSync(configDir, { recursive: true, force: true }));

test("a conversation exists once its transcript is in any project directory of CLAUDE_CONFIG_DIR", () => {
  const env = { CLAUDE_CONFIG_DIR: configDir };
  expect(claude.hasConversation?.(ID, env)).toBe(false);

  writeClaudeTranscript(
    configDir,
    "/some/where/.hidden_dir",
    "22222222-2222-4333-8444-555555555555",
  );
  expect(claude.hasConversation?.(ID, env)).toBe(false);

  writeClaudeTranscript(configDir, "/home/me/app", ID);
  expect(claude.hasConversation?.(ID, env)).toBe(true);
  expect(claude.hasConversation?.(ID, { CLAUDE_CONFIG_DIR: join(configDir, "elsewhere") })).toBe(
    false,
  );
});
