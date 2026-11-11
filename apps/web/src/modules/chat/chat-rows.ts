import type { ChatItem, ChatToolCall, ChatTurnState } from "@corral/protocol/chat";

/**
 * One timeline row. A finished turn folds into one line (`Worked`), a run of finished tool calls
 * folds into one verb summary (`Read 4 files and ran 2 commands`), and a running call keeps its
 * own row because its output is still arriving. Both folds are projection work, as in T3
 * (`MessagesTimeline.logic.ts`, `turn-fold`/`work-toggle`) and OpenCode
 * (`session-ui/src/timeline/projection.ts`).
 */
export type ChatRow =
  | { kind: "item"; key: string; item: ChatItem }
  /**
   * One call, with the words and the action its row shows. Both are computed here, where the call
   * is read once, rather than in the renderer, which runs again for every streamed delta.
   */
  | {
      kind: "tool";
      key: string;
      call: ChatToolCall;
      label: string;
      action: ChatToolAction;
    }
  /** A run of finished calls, summarised once, for the same reason. */
  | {
      kind: "group";
      key: string;
      items: readonly ChatToolCall[];
      label: string;
      action: ChatToolAction | "mixed";
      failed: boolean;
    }
  /**
   * A finished turn: `rows` are all of its rows, and `hidden` names the ones its fold hides until
   * it is expanded. The set is the projection's, not the renderer's: what a fold covers is a
   * question about the turn, not about an item's kind.
   */
  | { kind: "turn"; key: string; rows: readonly ChatRow[]; hidden: ReadonlySet<string> }
  /** The live tail while the turn runs; it becomes the turn's fold when the turn ends. */
  | { kind: "working"; key: string };

export interface ChatRowInput {
  readonly items: readonly ChatItem[];
  /** The session's turn. Only a working turn keeps its newest work unfolded. */
  readonly turn: ChatTurnState;
  /** The agent is waiting on the user, so the working row would claim work that is not happening. */
  readonly waiting: boolean;
  /**
   * The messages the agent is being steered with (`ChatSessionState.steering`). A steer is a
   * `user-message` item inside the running turn (`apps/server/src/chat/chat-rpc.test.ts:773`), so
   * it must not start a second turn: the turn it steered would fold mid-stream.
   */
  readonly steering?: readonly string[];
}

/** What one row of the transcript is. */
export function chatRows({ items, turn, waiting, steering = [] }: ChatRowInput): ChatRow[] {
  const rows: ChatRow[] = [];
  const steers = steerIds(items, turn, steering);
  const firstTurn = items.findIndex((item) => item.kind === "user-message");
  const start = firstTurn === -1 ? items.length : firstTurn;
  // A notice or an error before the first prompt belongs to no turn, but a run of calls still groups.
  rows.push(...projectRows(items.slice(0, start)));
  let index = start;
  while (index < items.length) {
    const item = items[index];
    if (item === undefined) {
      index += 1;
      continue;
    }
    const end = nextTurnStart(items, index + 1, steers);
    const segment = items.slice(index, end);
    const [prompt, ...work] = segment;
    // The prompt is never hidden: the fold covers the turn's work, not what asked for it.
    if (prompt !== undefined) rows.push({ kind: "item", key: prompt.id, item: prompt });
    if (folds(work, end === items.length ? turn : "settled")) {
      const turnRows = projectRows(work);
      rows.push({
        kind: "turn",
        key: `turn:${item.id}`,
        rows: turnRows,
        hidden: hiddenKeys(turnRows),
      });
    } else {
      rows.push(...projectRows(work));
    }
    index = end;
  }
  if (turn === "working" && !waiting) rows.push({ kind: "working", key: "working" });
  return rows;
}

function nextTurnStart(
  items: readonly ChatItem[],
  from: number,
  steers: ReadonlySet<string>,
): number {
  for (let index = from; index < items.length; index += 1) {
    const item = items[index];
    if (item?.kind === "user-message" && !steers.has(item.id)) return index;
  }
  return items.length;
}

/**
 * The user messages that steered the running turn rather than starting one. `steering` is in send
 * order, so each entry is matched to the last unclaimed prompt with its text; a steer and a prompt
 * that read the same therefore still map one-to-one, newest first.
 */
function steerIds(
  items: readonly ChatItem[],
  turn: ChatTurnState,
  steering: readonly string[],
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (turn !== "working" || steering.length === 0) return ids;
  let before = items.length;
  for (let steer = steering.length - 1; steer >= 0; steer -= 1) {
    const text = steering[steer];
    for (let index = before - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item?.kind !== "user-message" || item.text !== text) continue;
      ids.add(item.id);
      before = index;
      break;
    }
  }
  return ids;
}

/**
 * A turn folds once it has ended: T3 folds a finished run and leaves the live one, an interrupted
 * one and a failed one open (`MessagesTimeline.logic.ts:1101-1110`). A turn with nothing to hide
 * (no finished call, no reasoning) is not folded at all.
 */
function folds(segment: readonly ChatItem[], turn: ChatTurnState): boolean {
  if (turn === "working" || turn === "aborted" || turn === "error") return false;
  return segment.some(
    (item) =>
      (item.kind === "tool-call" && item.status !== "running") ||
      (item.kind === "reasoning" && item.text.trim() !== ""),
  );
}

/** One turn's rows: runs of two or more finished calls become one summary; anything else is a row. */
function projectRows(items: readonly ChatItem[]): ChatRow[] {
  const rows: ChatRow[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) continue;
    if (item.kind === "tool-call") {
      if (item.status !== "running") {
        const run: ChatToolCall[] = [item];
        while (true) {
          const next = items[index + run.length];
          if (next?.kind !== "tool-call" || next.status === "running") break;
          run.push(next);
        }
        if (run.length > 1) {
          const summary = toolGroupSummary(run);
          rows.push({
            kind: "group",
            key: `group:${item.id}`,
            items: run,
            label: summary.label,
            action: summary.action,
            failed: run.some((call) => call.status === "error"),
          });
          index += run.length - 1;
          continue;
        }
      }
      rows.push({
        kind: "tool",
        key: item.id,
        call: item,
        label: toolLabel(item),
        action: toolAction(item),
      });
      continue;
    }
    rows.push({ kind: "item", key: item.id, item });
  }
  return rows;
}

/**
 * What a finished turn's fold hides: its work rows and every assistant message but the turn's
 * terminal one. T3 hides every entry of the run except `group.terminalEntry`
 * (`MessagesTimeline.logic.ts:1118-1145`), and a Corral turn normally carries several messages
 * because each text block is its own item (`apps/server/src/chat/pi-projection.test.ts:311-320`).
 * A notice, an error and a request are never hidden: a request owns the keyboard.
 */
function hiddenKeys(rows: readonly ChatRow[]): ReadonlySet<string> {
  const terminal = rows.findLast(
    (row) => row.kind === "item" && row.item.kind === "assistant-message",
  );
  const hidden = new Set<string>();
  for (const row of rows) {
    if (row.key === terminal?.key) continue;
    if (row.kind === "group" || row.kind === "tool") {
      hidden.add(row.key);
      continue;
    }
    if (row.kind !== "item") continue;
    const kind = row.item.kind;
    if (kind === "tool-call" || kind === "reasoning" || kind === "assistant-message") {
      hidden.add(row.key);
    }
  }
  return hidden;
}

/** The pending request the agent waits on, if any; the last one wins if a driver appends two. */
export function pendingRequest(items: readonly ChatItem[]) {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === "user-request" && item.status === "pending") return item;
  }
  return undefined;
}

/** What a call did, read from its shape: the protocol's names change with the agent. */
export type ChatToolAction = "read" | "search" | "edit" | "run" | "other";

const SEARCH_KEYS = ["pattern", "query", "regex", "grep", "glob", "include", "filePattern"];
const READ_KEYS = ["path", "file_path", "filePath", "file", "filename"];
const EDIT_KEYS = ["edits", "oldText", "newText", "old_string", "new_string", "patch"];
/**
 * A write carries the file's new text next to its path. Claude's `Write` is `{file_path, content}`
 * and a create has no patch to carry, so its diff is `null` (`claude-projection.ts:648-658`) and
 * without these keys the call reads as a read. The path is required: a bare `text` belongs to
 * tools that are not about files.
 */
const WRITE_KEYS = ["content", "contents", "text"];
const RUN_KEYS = ["command", "cmd", "script"];
const SEARCH_TARGET_KEYS = ["path", "directory", "cwd", "root"];

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function argumentRecord(argumentsText: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Not JSON: the arguments are already text the agent wrote, so show them as they are.
  }
  return undefined;
}

function firstString(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (record === undefined) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return oneLine(value);
  }
  return undefined;
}

function hasKey(record: Record<string, unknown> | undefined, keys: readonly string[]): boolean {
  if (record === undefined) return false;
  return keys.some((key) => record[key] !== undefined);
}

/**
 * One call's action and label, remembered per call object: the timeline re-projects on every
 * streamed delta, and a call's arguments are the same string until the call itself changes.
 */
const READ_CALLS = new WeakMap<ChatToolCall, { action: ChatToolAction; label: string }>();

/** What a call did, read from its shape: the protocol's names change with the agent. */
export function toolAction(call: ChatToolCall): ChatToolAction {
  return readCall(call).action;
}

function readCall(call: ChatToolCall): { action: ChatToolAction; label: string } {
  const known = READ_CALLS.get(call);
  if (known !== undefined) return known;
  const record = argumentRecord(call.arguments);
  const action = classify(call, record);
  const label = labelFor(call, action, record);
  const read = { action, label };
  READ_CALLS.set(call, read);
  return read;
}

function classify(call: ChatToolCall, record: Record<string, unknown> | undefined): ChatToolAction {
  // A call that carries a change is an edit whatever else its arguments say.
  if (call.diff !== null) return "edit";
  if (hasKey(record, RUN_KEYS)) return "run";
  // A search carries a path too, so it is asked before a read.
  if (hasKey(record, SEARCH_KEYS)) return "search";
  if (hasKey(record, EDIT_KEYS)) return "edit";
  // A write names a path and the file's new text; a read names a path and nothing to write.
  if (hasKey(record, WRITE_KEYS) && hasKey(record, READ_KEYS)) return "edit";
  if (hasKey(record, READ_KEYS)) return "read";
  return "other";
}

/**
 * The one-line label of a call, in T3's words: `Read <path>` (`toolActivity.ts:386`), the command
 * it ran (`MessagesTimeline.logic.ts:142`), `Changed 1 file` for an edit
 * (`presentation.ts:462`) and the search sentence (`toolActivity.ts:361`). A running command says
 * `Running <program>` instead (`MessagesTimeline.logic.ts:253`).
 */
export function toolLabel(call: ChatToolCall): string {
  return readCall(call).label;
}

function labelFor(
  call: ChatToolCall,
  action: ChatToolAction,
  record: Record<string, unknown> | undefined,
): string {
  if (action === "read") {
    const path = firstString(record, READ_KEYS);
    return path === undefined ? "Read file" : `Read ${path}`;
  }
  if (action === "run") {
    const command = firstString(record, RUN_KEYS) ?? oneLine(call.arguments);
    if (call.status === "running") return `Running ${commandProgramName(command) ?? "command"}`;
    return command;
  }
  if (action === "edit") return changedFilesLabel(1);
  // T3's search sentence answers nothing when the call named neither a query nor a glob
  // (`toolActivity.ts:358-384` returns `undefined`), so the argument hint answers instead.
  if (action === "search") return searchLabel(record) ?? summaryFor(call.arguments, record);
  return summaryFor(call.arguments, record);
}

function changedFilesLabel(count: number): string {
  return `Changed ${count} ${count === 1 ? "file" : "files"}`;
}

/**
 * T3's search sentence, from whatever the call named: a query, a glob, or only a target. A call
 * that named none of them has no sentence — T3 answers `undefined` there too — and the caller
 * falls through to the argument hint.
 */
export function searchLabel(record: Record<string, unknown> | undefined): string | undefined {
  const query = firstString(record, ["pattern", "query", "regex", "grep"]);
  const glob = firstString(record, ["glob", "include", "filePattern"]);
  const target = searchTargetName(firstString(record, SEARCH_TARGET_KEYS));
  if (query !== undefined && target !== undefined) return `Searched ${query} in ${target}`;
  if (glob !== undefined && target !== undefined) return `Searched files ${glob} in ${target}`;
  if (glob !== undefined) return `Searched files ${glob}`;
  if (query !== undefined) return `Searched ${query}`;
  if (target !== undefined) return `Searched in ${target}`;
  return undefined;
}

function searchTargetName(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const parts = path.split(/[\\/]/u).filter((part) => part !== "" && part !== ".");
  return parts.at(-1);
}

/**
 * The one-line argument hint of a call the actions above do not classify. It reads the call's
 * shape, not the driver's tool name: the first string a JSON object carries or the raw text.
 */
export function toolSummary(argumentsText: string): string {
  return summaryFor(argumentsText, argumentRecord(argumentsText));
}

function summaryFor(argumentsText: string, record: Record<string, unknown> | undefined): string {
  if (record !== undefined) {
    for (const value of Object.values(record)) {
      if (typeof value === "string" && value.trim() !== "") return oneLine(value);
    }
  }
  return oneLine(argumentsText);
}

const SHELL_PROGRAMS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "fish"]);
const WRAPPERS = new Set(["env", "sudo", "command", "exec", "nohup"]);

/** Splits a command into words, keeping quoted runs together; escaping is left as written. */
function shellTokens(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const character of command) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

/**
 * The program a command really ran, as T3's `commandProgramName` reports it
 * (`work-log/commandLabel.ts`): past `NAME=value` assignments and `env`/`sudo` wrappers, and into
 * a shell's `-c` payload. Corral keeps the common shapes and falls back to the first word.
 */
export function commandProgramName(command: string, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  const tokens = shellTokens(command);
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) {
      index += 1;
      continue;
    }
    if (WRAPPERS.has(token)) {
      index += 1;
      while (tokens[index]?.startsWith("-") === true) index += 1;
      continue;
    }
    break;
  }
  const program = tokens[index];
  if (program === undefined) return undefined;
  const name = program.split(/[\\/]/u).at(-1) ?? program;
  if (SHELL_PROGRAMS.has(name)) {
    const payload = tokens.findIndex(
      (token, at) => at > index && /^-[A-Za-z]*c[A-Za-z]*$/u.test(token),
    );
    const script = payload === -1 ? undefined : tokens[payload + 1];
    if (script !== undefined) return commandProgramName(script, depth + 1) ?? name;
  }
  return name === "" ? undefined : name;
}

/** One verb group of a folded run, with the words T3's group summary uses. */
export interface ToolGroupSummary {
  /** `Read 2 files and ran 1 command`, or `Performed 1 other action` when only one group fits. */
  readonly label: string;
  /** The group's glyph: its single action, or `mixed` for a run that did several things. */
  readonly action: ChatToolAction | "mixed";
}

const ACTION_PRIORITY: Readonly<Record<ChatToolAction, number>> = {
  run: 0,
  edit: 0,
  read: 1,
  search: 1,
  other: 2,
};

function actionCount(action: ChatToolAction, calls: readonly ChatToolCall[]): number {
  if (action !== "edit") return calls.length;
  const files = new Set<string>();
  let withoutPath = 0;
  for (const call of calls) {
    if (call.diff === null || call.diff.path === null) withoutPath += 1;
    else files.add(call.diff.path);
  }
  return files.size + withoutPath;
}

/** T3's `toolGroupActionLabel` (`presentation.ts:445`), in the actions this protocol can show. */
const ACTION_LABELS: Readonly<Record<ChatToolAction, (count: number) => string>> = {
  read: (count) => `Read ${count} ${count === 1 ? "file" : "files"}`,
  edit: changedFilesLabel,
  run: (count) => `Ran ${count} ${count === 1 ? "command" : "commands"}`,
  // T3 keeps a web search and a code search apart by tool name (`search` vs `code-search`,
  // `presentation.ts:471-474`); the contract's shape says only that a search happened, so the one
  // noun covers both. `docs/ux.md`, **Known limits** states the same.
  search: (count) => `Searched code ${count} ${count === 1 ? "time" : "times"}`,
  other: (count) => `Used ${count} ${count === 1 ? "tool" : "tools"}`,
};

function actionLabel(action: ChatToolAction, count: number): string {
  return ACTION_LABELS[action](count);
}

/**
 * The summary of a folded run (`summarizeToolGroup`, `presentation.ts:532`): at most two verb
 * groups, the loudest first, and the rest counted rather than listed.
 */
export function toolGroupSummary(calls: readonly ChatToolCall[]): ToolGroupSummary {
  const groups = new Map<ChatToolAction, ChatToolCall[]>();
  for (const call of calls) {
    const action = toolAction(call);
    const group = groups.get(action);
    if (group === undefined) groups.set(action, [call]);
    else group.push(call);
  }
  const entries = [...groups].map(([action, members], order) => ({
    action,
    order,
    count: members.length,
    priority: ACTION_PRIORITY[action],
  }));
  const selected = entries
    .toSorted((left, right) => left.priority - right.priority || left.order - right.order)
    .slice(0, 2)
    .toSorted((left, right) => left.order - right.order);
  const labels = selected.map((group) =>
    actionLabel(group.action, actionCount(group.action, groups.get(group.action) ?? [])),
  );
  const remaining = calls.length - selected.reduce((total, group) => total + group.count, 0);
  if (remaining > 0) {
    labels.push(`Performed ${remaining} other ${remaining === 1 ? "action" : "actions"}`);
  }
  const sentences = labels.map((label, index) =>
    index === 0 ? label : `${label.charAt(0).toLowerCase()}${label.slice(1)}`,
  );
  const label =
    sentences.length < 3
      ? sentences.join(" and ")
      : `${sentences.slice(0, -1).join(", ")}, and ${sentences.at(-1) ?? ""}`;
  return { label, action: groups.size === 1 ? (entries[0]?.action ?? "other") : "mixed" };
}
