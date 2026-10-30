import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * Writes a Codex rollout file where Codex would: `<home>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`,
 * its first line a `session_meta` record (shape taken from a real rollout, trimmed).
 */
export function writeRollout(
  home: string,
  rollout: { id: string; cwd: string; startedAt?: Date; firstLine?: string },
): string {
  const startedAt = rollout.startedAt ?? new Date();
  const directory = join(
    home,
    "sessions",
    String(startedAt.getFullYear()),
    pad(startedAt.getMonth() + 1),
    pad(startedAt.getDate()),
  );
  mkdirSync(directory, { recursive: true });
  const stamp = startedAt.toISOString().slice(0, 19).replaceAll(":", "-");
  const path = join(directory, `rollout-${stamp}-${rollout.id}.jsonl`);
  const meta = {
    timestamp: startedAt.toISOString(),
    type: "session_meta",
    payload: {
      session_id: rollout.id,
      id: rollout.id,
      timestamp: startedAt.toISOString(),
      cwd: rollout.cwd,
      originator: "codex-tui",
    },
  };
  writeFileSync(path, `${rollout.firstLine ?? JSON.stringify(meta)}\n`);
  return path;
}
