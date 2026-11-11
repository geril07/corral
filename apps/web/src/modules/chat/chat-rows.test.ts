import type { ChatItem, ChatToolCall } from "@corral/protocol/chat";
import { expect, test } from "vite-plus/test";
import {
  chatRows,
  commandProgramName,
  pendingRequest,
  searchLabel,
  toolAction,
  toolGroupSummary,
  toolLabel,
  toolSummary,
} from "./chat-rows.ts";

const call = (
  id: string,
  status: ChatToolCall["status"],
  overrides: Partial<ChatToolCall> = {},
): ChatToolCall => ({
  kind: "tool-call",
  id,
  name: "read",
  arguments: `{"path":"${id}.ts"}`,
  status,
  output: null,
  diff: null,
  ...overrides,
});

const user = (id: string): ChatItem => ({ kind: "user-message", id, text: "hello" });

const readCall = (id: string): ChatToolCall =>
  call(id, "done", { arguments: '{"path":"src/a.ts"}' });
const runCall = (id: string): ChatToolCall =>
  call(id, "done", { arguments: '{"command":"pnpm test"}' });
const editCall = (id: string): ChatToolCall =>
  call(id, "done", { diff: { path: "src/a.ts", text: "--- a\n+++ b\n" } });

const message = (id: string, text: string): ChatItem => ({
  kind: "assistant-message",
  id,
  text,
  streaming: false,
});

const settled = { turn: "settled", waiting: false } as const;
const working = { turn: "working", waiting: false } as const;

test("consecutive finished tool calls fold; a running call stays its own row", () => {
  expect(
    chatRows({
      items: [call("a", "done"), call("b", "error"), call("c", "running")],
      ...settled,
    }),
  ).toEqual([
    { kind: "group", key: "group:a", items: [call("a", "done"), call("b", "error")] },
    { kind: "item", key: "c", item: call("c", "running") },
  ]);
});

test("a single finished call is not a group", () => {
  expect(chatRows({ items: [call("a", "done")], ...settled })).toEqual([
    { kind: "item", key: "a", item: call("a", "done") },
  ]);
});

test("a finished turn folds its work behind one row and keeps its terminal message", () => {
  const answer: ChatItem = {
    kind: "assistant-message",
    id: "a1",
    text: "Done.",
    streaming: false,
  };
  const rows = chatRows({
    items: [user("u1"), call("t1", "done"), call("t2", "done"), answer, user("u2")],
    ...settled,
  });
  expect(rows.map((row) => row.key)).toEqual(["u1", "turn:u1", "u2"]);
  const fold = rows[1];
  if (fold?.kind !== "turn") throw new Error("the turn did not fold");
  expect(fold.rows.map((row) => row.key)).toEqual(["group:t1", "a1"]);
  // The turn's terminal message is the one row the fold leaves in place (T3 hides every other
  // entry of the run, `MessagesTimeline.logic.ts:1118-1145`).
  expect([...fold.hidden]).toEqual(["group:t1"]);
});

test("a narrating turn folds its intermediate messages and keeps only the last one", () => {
  const rows = chatRows({
    items: [
      user("u1"),
      message("a1", "Let me read the test first."),
      call("t1", "done"),
      message("a2", "Now the module it exercises."),
      call("t2", "done"),
      message("a3", "Fixed."),
      user("u2"),
    ],
    ...settled,
  });
  const fold = rows[1];
  if (fold?.kind !== "turn") throw new Error("the turn did not fold");
  // Every text block is its own item (`pi-projection.test.ts:311-320`), so a turn normally has
  // several; only the terminal one survives the fold.
  expect(fold.rows.map((row) => row.key)).toEqual(["a1", "t1", "a2", "t2", "a3"]);
  expect([...fold.hidden]).toEqual(["a1", "t1", "a2", "t2"]);
});

test("a notice, an error and a request inside a turn are never hidden", () => {
  const notice: ChatItem = { kind: "notice", id: "n1", text: "Compacted." };
  const error: ChatItem = { kind: "error", id: "e1", text: "The retry failed." };
  const request: ChatItem = {
    kind: "user-request",
    id: "q1",
    request: "confirm",
    title: "Proceed?",
    body: null,
    options: [],
    placeholder: null,
    prefill: null,
    expiresAt: null,
    status: "answered",
    answer: true,
  };
  const rows = chatRows({
    items: [user("u1"), call("t1", "done"), notice, error, request, user("u2")],
    ...settled,
  });
  const fold = rows[1];
  if (fold?.kind !== "turn") throw new Error("the turn did not fold");
  expect([...fold.hidden]).toEqual(["t1"]);
});

test("a turn with nothing to hide, and the live turn, stay unfolded", () => {
  const answer: ChatItem = { kind: "assistant-message", id: "a1", text: "Hi.", streaming: false };
  expect(chatRows({ items: [user("u1"), answer], ...settled })).toEqual([
    { kind: "item", key: "u1", item: user("u1") },
    { kind: "item", key: "a1", item: answer },
  ]);
  // The newest turn is the one running, so its work is what the user is watching.
  expect(
    chatRows({ items: [user("u1"), call("t1", "done")], ...working }).map((row) => row.kind),
  ).toEqual(["item", "item", "working"]);
});

test("an aborted or failed turn does not fold, so the stopped work stays visible", () => {
  for (const turn of ["aborted", "error"] as const) {
    expect(
      chatRows({ items: [user("u1"), call("t1", "done")], turn, waiting: false }).map(
        (row) => row.kind,
      ),
    ).toEqual(["item", "item"]);
  }
});

test("the live tail is absent while the agent waits on the user", () => {
  expect(
    chatRows({ items: [user("u1"), call("t1", "running")], turn: "working", waiting: true }).map(
      (row) => row.kind,
    ),
  ).toEqual(["item", "item"]);
});

test("an action is read from the call's shape, never its name", () => {
  expect(toolAction(call("a", "done", { name: "whatever", arguments: '{"path":"x"}' }))).toBe(
    "read",
  );
  expect(
    toolAction(call("b", "done", { name: "read", arguments: '{"command":"pnpm test"}' })),
  ).toBe("run");
  // A search carries a path too; the query is what makes it a search.
  expect(
    toolAction(call("c", "done", { name: "grep", arguments: '{"pattern":"x","path":"src"}' })),
  ).toBe("search");
  expect(toolAction(call("d", "done", { name: "apply_patch", arguments: '{"edits":[]}' }))).toBe(
    "edit",
  );
  expect(
    toolAction(
      call("e", "done", {
        name: "edit",
        arguments: '{"path":"x"}',
        diff: { path: "x", text: "--- x\n+++ x\n" },
      }),
    ),
  ).toBe("edit");
  expect(toolAction(call("f", "done", { name: "think", arguments: '{"thought":"hmm"}' }))).toBe(
    "other",
  );
});

test("a call's row says what it did, in the reference's words", () => {
  expect(toolLabel(call("a", "done", { arguments: '{"path":"src/a.ts"}' }))).toBe("Read src/a.ts");
  expect(toolLabel(call("b", "done", { arguments: '{"path":""}' }))).toBe("Read file");
  expect(toolLabel(call("c", "done", { arguments: '{"command":"pnpm vitest run"}' }))).toBe(
    "pnpm vitest run",
  );
  expect(toolLabel(call("d", "running", { arguments: '{"command":"pnpm vitest run"}' }))).toBe(
    "Running pnpm",
  );
  expect(
    toolLabel(call("e", "done", { arguments: '{"pattern":"cookie","path":"src/x.ts"}' })),
  ).toBe("Searched cookie in x.ts");
  expect(toolLabel(call("f", "done", { diff: { path: "src/a.ts", text: "--- a\n+++ b\n" } }))).toBe(
    "Changed 1 file",
  );
  expect(toolLabel(call("g", "done", { arguments: '{"note":"looking"}' }))).toBe("looking");
});

test("a folded run counts its verbs and names at most two of them", () => {
  expect(toolGroupSummary([readCall("1"), readCall("2")])).toEqual({
    label: "Read 2 files",
    action: "read",
  });
  expect(toolGroupSummary([runCall("1"), editCall("2"), readCall("3")])).toEqual({
    label: "Ran 1 command, changed 1 file, and performed 1 other action",
    action: "mixed",
  });
  expect(toolGroupSummary([runCall("1"), runCall("2"), runCall("3")])).toEqual({
    label: "Ran 3 commands",
    action: "run",
  });
});

test("two edits to one file count once", () => {
  const patch = { path: "src/a.ts", text: "--- a\n+++ b\n" };
  expect(
    toolGroupSummary([call("1", "done", { diff: patch }), call("2", "done", { diff: patch })])
      .label,
  ).toBe("Changed 1 file");
});

test("a command's program is found past assignments, wrappers and a shell's -c", () => {
  expect(commandProgramName("pnpm vitest run src/a.test.ts")).toBe("pnpm");
  expect(commandProgramName("FOO=1 BAR=2 pnpm test")).toBe("pnpm");
  expect(commandProgramName("env -i node script.mjs")).toBe("node");
  expect(commandProgramName('bash -lc "pnpm typecheck"')).toBe("pnpm");
  expect(commandProgramName("/usr/bin/git status")).toBe("git");
  expect(commandProgramName("")).toBeUndefined();
});

test("a search sentence names the query, the glob and the target it has", () => {
  expect(searchLabel({ pattern: "cookie", path: "src/lib/x.ts" })).toBe("Searched cookie in x.ts");
  expect(searchLabel({ glob: "**/*.ts" })).toBe("Searched files **/*.ts");
  expect(searchLabel({ query: "cookie", glob: "**/*.ts" })).toBe("Searched files **/*.ts");
  // A call that named no query, glob or target has no sentence; the caller falls through to the
  // argument hint, as T3's `formatSearchToolLabel` answers `undefined` there.
  expect(searchLabel({})).toBeUndefined();
});

test("the argument hint reads the first string of the shape, not the tool name", () => {
  expect(toolSummary('{"path":"src/a.ts","edits":[]}')).toBe("src/a.ts");
  expect(toolSummary('{"command":"pnpm test"}')).toBe("pnpm test");
  expect(toolSummary("not json")).toBe("not json");
  expect(toolSummary('{"count":2}')).toBe('{"count":2}');
});

test("the last pending request is the one the view answers", () => {
  const answered: ChatItem = {
    kind: "user-request",
    id: "q1",
    request: "confirm",
    title: "Proceed?",
    body: null,
    options: [],
    placeholder: null,
    prefill: null,
    expiresAt: null,
    status: "answered",
    answer: true,
  };
  const pending: ChatItem = {
    ...answered,
    id: "q2",
    status: "pending",
    answer: undefined,
  };
  expect(pendingRequest([answered])).toBeUndefined();
  expect(pendingRequest([answered, pending])?.id).toBe("q2");
});
