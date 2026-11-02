// Workaround: Codex cannot be started under an id we choose, and Corral installs no hook in the
// user's global Codex config. Instead the server finds the rollout file the new Codex process
// writes in `$CODEX_HOME/sessions`. Everything that depends on Codex's file layout is in here.
import { readdirSync } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 250;
/** A rollout's first line holds the whole system prompt, so it can be long; past this it is not worth waiting for. */
const MAX_HEAD_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export function codexHome(env: NodeJS.ProcessEnv): string {
  return env["CODEX_HOME"] || join(homedir(), ".codex");
}

/**
 * Whether this Codex home holds the rollout of `id`. It is the durable conversation: `thread/start`
 * through the app-server (or the TUI) creates a thread, but only a turn writes the file, so an id
 * without one cannot be resumed. Synchronous, like Claude's transcript check, because it answers a
 * launch's `resumable` question before any argv is built; a home has a handful of day directories.
 */
export function codexHasRollout(home: string, agentSessionId: string): boolean {
  const root = join(home, "sessions");
  const suffix = `-${agentSessionId}.jsonl`;
  for (const year of numericDirectories(root)) {
    for (const month of numericDirectories(join(root, year))) {
      for (const day of numericDirectories(join(root, year, month))) {
        const directory = join(root, year, month, day);
        try {
          if (readdirSync(directory).some((name) => name.endsWith(suffix))) return true;
        } catch {
          // A day directory can vanish between listings; the next one may still have the file.
        }
      }
    }
  }
  return false;
}

function numericDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export interface RolloutHead {
  id: string;
  cwd: string;
  /** Epoch milliseconds at which Codex started the conversation. */
  startedAt: number;
}

const SessionMeta = z.object({
  type: z.literal("session_meta"),
  payload: z.object({ id: z.string().min(1), cwd: z.string(), timestamp: z.string() }),
});

/** The first line of a `rollout-*.jsonl` file; `undefined` for anything that is not a `session_meta` record. */
export function parseRolloutHead(line: string): RolloutHead | undefined {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return undefined;
  }
  const parsed = SessionMeta.safeParse(json);
  if (!parsed.success) return undefined;
  const { id, cwd, timestamp } = parsed.data.payload;
  const startedAt = Date.parse(timestamp);
  return Number.isNaN(startedAt) ? undefined : { id, cwd, startedAt };
}

/**
 * The id of the one conversation that started in `cwds` at or after `since` and that no other
 * session claimed. With several candidates there is no telling which is ours, and guessing would
 * resume someone else's conversation, so there is no answer.
 */
export function chooseNewConversation(
  heads: readonly RolloutHead[],
  filter: { cwds: ReadonlySet<string>; since: number; claimed: ReadonlySet<string> },
): string | undefined {
  const candidates = new Set(
    heads
      .filter(
        (head) =>
          filter.cwds.has(head.cwd) &&
          head.startedAt >= filter.since &&
          !filter.claimed.has(head.id),
      )
      .map((head) => head.id),
  );
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

async function subdirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** Rollout files in `sessions/YYYY/MM/DD` directories that can hold a conversation started at or after `since`. */
async function rolloutFilesSince(home: string, since: number): Promise<string[]> {
  // Directory dates are local time; two days of slack cover every offset.
  const threshold = since - 2 * DAY_MS;
  const root = join(home, "sessions");
  const years = (await subdirectories(root)).filter(
    (year) => Date.UTC(Number(year) + 1, 0, 1) > threshold,
  );
  const dayDirectories = await Promise.all(
    years.map(async (year) => {
      const months = (await subdirectories(join(root, year))).filter(
        (month) => Date.UTC(Number(year), Number(month), 1) > threshold,
      );
      const days = await Promise.all(
        months.map(async (month) =>
          (await subdirectories(join(root, year, month)))
            .filter((day) => Date.UTC(Number(year), Number(month) - 1, Number(day) + 1) > threshold)
            .map((day) => join(root, year, month, day)),
        ),
      );
      return days.flat();
    }),
  );
  const files = await Promise.all(
    dayDirectories.flat().map(async (directory) =>
      // A directory may vanish between listing and reading.
      (await readdir(directory).catch(() => []))
        .filter((name) => name.startsWith("rollout-") && name.endsWith(".jsonl"))
        .map((name) => join(directory, name)),
    ),
  );
  return files.flat();
}

/** `incomplete`: the first line is still being written. `undefined`: it is not a session record. */
async function readRolloutHead(path: string): Promise<RolloutHead | undefined | "incomplete"> {
  const file = await open(path, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < MAX_HEAD_BYTES) {
      const buffer = Buffer.alloc(READ_CHUNK_BYTES);
      // oxlint-disable-next-line no-await-in-loop -- the line ends where the next chunk says
      const { bytesRead } = await file.read(buffer, 0, READ_CHUNK_BYTES, total);
      if (bytesRead === 0) return "incomplete";
      const chunk = buffer.subarray(0, bytesRead);
      const newline = chunk.indexOf(0x0a);
      if (newline >= 0) {
        chunks.push(chunk.subarray(0, newline));
        return parseRolloutHead(Buffer.concat(chunks).toString("utf8"));
      }
      chunks.push(chunk);
      total += bytesRead;
    }
    return undefined;
  } finally {
    await file.close();
  }
}

export interface CodexSessionWatch {
  /** Stops polling and looks one last time, e.g. after the process exited; resolves once `onFound` has run if it will. */
  finish(): Promise<void>;
}

/**
 * Polls for the rollout of a Codex process started in `cwd` at `since`. Codex may create the
 * file only on the first prompt, so the watch lasts until `onFound` or `finish`.
 */
export function watchForCodexSession(options: {
  home: string;
  cwd: string;
  since: number;
  /** Conversations other sessions already hold; read on every look. */
  claimedIds: () => ReadonlySet<string>;
  onFound: (id: string) => void;
  pollMs?: number;
}): CodexSessionWatch {
  const settled = new Map<string, RolloutHead | undefined>();
  let found = false;
  let stopped = false;
  let reportedFailure = false;
  let timer: NodeJS.Timeout | undefined;
  let queue: Promise<void> = Promise.resolve();

  async function look(): Promise<void> {
    if (found) return;
    const cwds = new Set([options.cwd]);
    await realpath(options.cwd).then(
      (real) => cwds.add(real),
      () => undefined,
    );
    for (const path of await rolloutFilesSince(options.home, options.since)) {
      if (settled.has(path)) continue;
      // oxlint-disable-next-line no-await-in-loop -- a few small files; one at a time is enough
      const head = await readRolloutHead(path).catch(() => "incomplete" as const);
      if (head !== "incomplete") settled.set(path, head);
    }
    const heads = [...settled.values()].filter((head) => head !== undefined);
    const id = chooseNewConversation(heads, {
      cwds,
      since: options.since,
      claimed: options.claimedIds(),
    });
    if (id === undefined) return;
    found = true;
    clearTimeout(timer);
    options.onFound(id);
  }

  function lookSafely(): Promise<void> {
    queue = queue.then(look).catch((error: unknown) => {
      if (reportedFailure) return;
      reportedFailure = true;
      console.error(`corral-server: looking for a Codex session in ${options.home} failed`, error);
    });
    return queue;
  }

  function schedule(): void {
    timer = setTimeout(() => {
      void lookSafely().then(() => {
        if (!found && !stopped) schedule();
      });
    }, options.pollMs ?? DEFAULT_POLL_MS);
    timer.unref();
  }
  schedule();

  return {
    async finish() {
      stopped = true;
      clearTimeout(timer);
      await lookSafely();
    },
  };
}
