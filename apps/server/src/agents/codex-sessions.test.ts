import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { writeRollout } from "../../test/rollouts.ts";
import {
  chooseNewConversation,
  parseRolloutHead,
  watchForCodexSession,
  type CodexSessionWatch,
} from "./codex-sessions.ts";

const NOTHING_CLAIMED: ReadonlySet<string> = new Set();

test("the first line of a real rollout gives its id, directory and start time", () => {
  const line = JSON.stringify({
    timestamp: "2026-10-26T20:05:34.600Z",
    type: "session_meta",
    payload: {
      session_id: "01a179d1-aaaa",
      id: "01a179d1-aaaa",
      timestamp: "2026-10-26T20:05:34.589Z",
      cwd: "/home/me/app",
      originator: "codex-tui",
    },
  });
  expect(parseRolloutHead(line)).toEqual({
    id: "01a179d1-aaaa",
    cwd: "/home/me/app",
    startedAt: Date.parse("2026-10-26T20:05:34.589Z"),
  });
});

test("lines that are not a session record, or not JSON, give nothing", () => {
  expect(parseRolloutHead('{"type":"event_msg","payload":{}}')).toBeUndefined();
  expect(
    parseRolloutHead('{"type":"session_meta","payload":{"id":"x","cwd":"/a"}}'),
  ).toBeUndefined();
  expect(
    parseRolloutHead('{"type":"session_meta","payload":{"id":"x","cwd":"/a","timestamp":"soon"}}'),
  ).toBeUndefined();
  expect(parseRolloutHead('{"type":"session_meta","pay')).toBeUndefined();
  expect(parseRolloutHead("")).toBeUndefined();
});

test("a conversation is chosen only when exactly one new one started in the workspace", () => {
  const cwds = new Set(["/work"]);
  const mine = { id: "mine", cwd: "/work", startedAt: 1000 };
  const filter = { cwds, since: 1000, claimed: NOTHING_CLAIMED };

  expect(chooseNewConversation([mine], filter)).toBe("mine");
  expect(chooseNewConversation([], filter)).toBeUndefined();
  expect(chooseNewConversation([{ ...mine, startedAt: 999 }], filter)).toBeUndefined();
  expect(chooseNewConversation([{ ...mine, cwd: "/elsewhere" }], filter)).toBeUndefined();
  expect(chooseNewConversation([mine], { ...filter, claimed: new Set(["mine"]) })).toBeUndefined();
  expect(chooseNewConversation([mine, { ...mine, id: "other" }], filter)).toBeUndefined();
  expect(
    chooseNewConversation([mine, { ...mine, id: "other" }], {
      ...filter,
      claimed: new Set(["other"]),
    }),
  ).toBe("mine");
  expect(chooseNewConversation([mine, mine], filter)).toBe("mine");
});

let home: string;
let watches: CodexSessionWatch[];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "corral-codex-"));
  watches = [];
});
afterEach(async () => {
  await Promise.all(watches.map((watch) => watch.finish()));
  rmSync(home, { recursive: true, force: true });
});

function watchFor(since: number, claimed: ReadonlySet<string> = NOTHING_CLAIMED) {
  const found: string[] = [];
  const watch = watchForCodexSession({
    home,
    cwd: "/work",
    since,
    claimedIds: () => claimed,
    onFound: (id) => found.push(id),
    pollMs: 10,
  });
  watches.push(watch);
  return { found, watch };
}

function foundWithin(found: string[]): Promise<string> {
  return expect
    .poll(() => found[0], { timeout: 10_000 })
    .toBeDefined()
    .then(() => found[0]!);
}

test("a rollout that appears after the watch started, in the workspace, is found once", async () => {
  const since = Date.now();
  const { found } = watchFor(since);
  writeRollout(home, { id: "old", cwd: "/work", startedAt: new Date(since - 60_000) });
  writeRollout(home, { id: "foreign", cwd: "/elsewhere", startedAt: new Date(since + 1) });
  writeRollout(home, { id: "mine", cwd: "/work", startedAt: new Date(since + 2) });

  expect(await foundWithin(found)).toBe("mine");
  await watches[0]!.finish();
  expect(found).toEqual(["mine"]);
});

test("a first line still being written is read again once it is complete", async () => {
  const since = Date.now();
  const { found, watch } = watchFor(since);
  const path = writeRollout(home, { id: "mine", cwd: "/work", startedAt: new Date(since + 1) });
  const complete = readFileSync(path, "utf8");
  writeFileSync(path, complete.slice(0, 40));
  await watch.finish();
  expect(found).toEqual([]);

  writeFileSync(path, complete);
  await watch.finish();
  expect(found).toEqual(["mine"]);
});

test("two new rollouts in the workspace are ambiguous: nothing is chosen", async () => {
  const since = Date.now();
  const { found, watch } = watchFor(since);
  writeRollout(home, { id: "a", cwd: "/work", startedAt: new Date(since + 1) });
  writeRollout(home, { id: "b", cwd: "/work", startedAt: new Date(since + 2) });

  await watch.finish();
  expect(found).toEqual([]);
});

test("a conversation another session claimed is not taken", async () => {
  const since = Date.now();
  const { found, watch } = watchFor(since, new Set(["theirs"]));
  writeRollout(home, { id: "theirs", cwd: "/work", startedAt: new Date(since + 1) });
  writeRollout(home, { id: "mine", cwd: "/work", startedAt: new Date(since + 2) });

  await watch.finish();
  expect(found).toEqual(["mine"]);
});

test("finish looks one last time, so a rollout written just before the exit is not missed", async () => {
  const since = Date.now();
  const found: string[] = [];
  const watch = watchForCodexSession({
    home,
    cwd: "/work",
    since,
    claimedIds: () => NOTHING_CLAIMED,
    onFound: (id) => found.push(id),
    pollMs: 60_000,
  });
  writeRollout(home, { id: "late", cwd: "/work", startedAt: new Date(since + 1) });

  await watch.finish();
  expect(found).toEqual(["late"]);
});

test("a home without sessions finds nothing and does not fail", async () => {
  const { found, watch } = watchFor(Date.now());
  await watch.finish();
  expect(found).toEqual([]);
});
