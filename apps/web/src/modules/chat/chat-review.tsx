import type { ChatItem, ChatSessionState } from "@corral/protocol/chat";
import type { ChatStore } from "@corral/client/chat-store";
import type { ChatStoreSnapshot } from "@corral/client/chat-state";
import { useState } from "react";
import { Button, VisualIconButton } from "../../common/ui/index.ts";
import { ChatView } from "./chat-view.tsx";
import type { ChatTranscriptStore } from "./chat-transcript.ts";
import type { ChatFiles } from "./local-links.tsx";

/**
 * A development-only host for chat rows the seeded .dev/ data does not reach: a live reasoning row,
 * a running command, a folded turn with a diff, a failed call and a pending request. The fixtures
 * are rendered through the same `ChatView` as production and never enter the app's chat store.
 */

const NO_FILES: ChatFiles = {
  resolve: async () => [],
  read: async () => {
    throw new Error("the review host reads no files");
  },
  open: async () => undefined,
};

const BASE_STATE: ChatSessionState = {
  turn: "working",
  steering: [],
  followUp: [],
  model: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet 4.5" },
  models: [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Sonnet 4.5" }],
  reasoning: "high",
  reasoningLevels: ["low", "medium", "high"],
  context: null,
};

const PROMPT: ChatItem = {
  kind: "user-message",
  id: "u1",
  text: "The upload retries forever. Find out why, then fix it without changing the request body.",
};

const REASONING =
  "The retry loop re-sends a FormData whose body the first fetch already consumed. Either rebuild the body per attempt or clone it before the first send.";

const REASONING_DONE: ChatItem = {
  kind: "reasoning",
  id: "r1",
  text: REASONING,
  streaming: false,
};

const REASONING_LIVE: ChatItem = {
  kind: "reasoning",
  id: "r1",
  text: `${REASONING} The second attempt fails before the server sees it…`,
  streaming: true,
};

const READ: ChatItem = {
  kind: "tool-call",
  id: "t-read",
  name: "read",
  arguments: '{"path":"src/upload.ts"}',
  status: "done",
  output:
    "export async function upload(file: File): Promise<void> {\n  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {\n    const response = await fetch('/api/upload', { method: 'POST', body: file });\n    if (response.ok) return;\n  }\n  throw new Error('upload failed');\n}",
  diff: null,
};

const RUN: ChatItem = {
  kind: "tool-call",
  id: "t-run",
  name: "bash",
  arguments: '{"command":"pnpm vitest run src/upload.test.ts"}',
  status: "done",
  output:
    " RUN  v5.0.5 /home/dev/orbit\n\n ✓ src/upload.test.ts > uploads a file\n ✗ src/upload.test.ts > keeps the body after a 401\n   → TypeError: Body has already been consumed\n\n Tests  1 failed | 1 passed (2)",
  diff: null,
};

const RUNNING: ChatItem = {
  ...RUN,
  status: "running",
  output: " RUN  v5.0.5 /home/dev/orbit\n\n ✓ src/upload.test.ts > uploads a file",
};

const FAILED: ChatItem = {
  ...RUN,
  status: "error",
  output:
    " RUN  v5.0.5 /home/dev/orbit\n\n ✗ src/upload.test.ts > keeps the body after a 401\n   → TypeError: Body has already been consumed\n\n ELIFECYCLE  Command failed with exit code 1.",
};

const LONG_COMMAND =
  "pnpm vitest run src/upload.test.ts src/retry.test.ts --coverage --reporter=verbose --testTimeout=10000";

const LONG_RUN: ChatItem = {
  ...RUN,
  id: "t-long",
  arguments: JSON.stringify({ command: LONG_COMMAND }),
};

const PATCH = [
  "--- src/upload.ts",
  "+++ src/upload.ts",
  "@@ -1,3 +1,5 @@",
  "-export async function upload(file: File): Promise<void> {",
  "-  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {",
  "+export async function upload(source: Blob): Promise<void> {",
  "+  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {",
  "+    const file = new FormData();",
  "+    file.set('upload', source);",
  "     const response = await fetch('/api/upload', { method: 'POST', body: file });",
].join("\n");

const EDIT: ChatItem = {
  kind: "tool-call",
  id: "t-edit",
  name: "edit",
  arguments: '{"path":"src/upload.ts"}',
  status: "done",
  output: null,
  diff: { path: "src/upload.ts", text: PATCH },
};

/**
 * A patch that touched two files: the contract carries one `path` slot, so a driver sends `null`
 * and the patch names both files itself.
 */
const MULTI_PATCH = [
  PATCH,
  "--- src/retry.ts",
  "+++ src/retry.ts",
  "@@ -1,2 +1,3 @@",
  " const RETRIES = 3;",
  "+const BACKOFF_MS = 250;",
  " export function retryDelay(attempt: number): number {",
].join("\n");

/** A patch whose result named no file: the contract's one path slot stayed empty. */
const MULTI_EDIT: ChatItem = {
  ...EDIT,
  id: "t-nameless",
  name: "apply_patch",
  arguments: '{"edits":[{"path":"src/upload.ts"},{"path":"src/retry.ts"}]}',
  diff: { path: null, text: MULTI_PATCH },
};

/** A whole-file write: no patch to render, so its card is the path and the text it put there. */
const WRITE: ChatItem = {
  kind: "tool-call",
  id: "t-write",
  name: "Write",
  arguments: JSON.stringify({
    file_path: "src/retry.ts",
    content:
      "const RETRIES = 3;\n\nexport async function withRetry<T>(run: () => Promise<T>): Promise<T> {\n  let last: unknown;\n  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {\n    try {\n      return await run();\n    } catch (error) {\n      last = error;\n    }\n  }\n  throw last;\n}\n",
  }),
  status: "done",
  output: null,
  diff: null,
};

const ANSWER: ChatItem = {
  kind: "assistant-message",
  id: "a1",
  text: "Upload now builds a fresh `FormData` for every attempt. The new case covers the 401 path, and the body is no longer re-sent after it was consumed.",
  streaming: false,
};

const ANSWER_LIVE: ChatItem = {
  ...ANSWER,
  text: "Upload now builds a fresh `FormData` for every attempt.",
  streaming: true,
};

const ERROR: ChatItem = {
  kind: "error",
  id: "e1",
  text: "The test command was refused once.",
};

/** Enough finished turns for the virtualized list to scroll: what a real session looks like. */
function longTranscript(): ChatItem[] {
  return Array.from({ length: 14 }, (_, index): ChatItem[] => {
    const turn = index + 1;
    return [
      {
        kind: "user-message",
        id: `u-${turn}`,
        text: `Attempt ${turn}: the upload still fails on the 401 path.`,
      },
      { kind: "reasoning", id: `r-${turn}`, text: REASONING, streaming: false },
      {
        kind: "tool-call",
        id: `run-${turn}`,
        name: "bash",
        arguments: '{"command":"pnpm vitest run src/upload.test.ts"}',
        status: "done",
        output: ` RUN  v5.0.5 /home/dev/orbit\n\n ✓ src/upload.test.ts > uploads a file (attempt ${turn})`,
        diff: null,
      },
      {
        kind: "assistant-message",
        id: `a-${turn}`,
        text: `Attempt ${turn} still reuses the consumed body. The fix rebuilds the \`FormData\` per attempt.`,
        streaming: false,
      },
    ];
  }).flat();
}

/** Enough finished calls in one open group that the group is taller than the pane: the scroll case. */
function longGroup(): ChatItem[] {
  return Array.from({ length: 16 }, (_, index): ChatItem => {
    const run = index + 1;
    return {
      kind: "tool-call",
      id: `g-run-${run}`,
      name: "bash",
      arguments: JSON.stringify({ command: `pnpm vitest run src/case-${run}.test.ts` }),
      status: "done",
      output: [
        ` RUN  v5.0.5 /home/dev/orbit`,
        "",
        ...Array.from(
          { length: 6 },
          (value, line) => ` ✓ src/case-${run}.test.ts > case ${line + 1} passes`,
        ),
        "",
        ` Tests  ${6 + run} passed (${6 + run})`,
      ].join("\n"),
      diff: null,
    };
  });
}

/** Calls with text between them, so each is its own row: the lone-call scroll case. */
function longCalls(): ChatItem[] {
  return Array.from({ length: 3 }, (_, index): ChatItem[] => {
    const run = index + 1;
    return [
      {
        kind: "tool-call",
        id: `solo-${run}`,
        name: "bash",
        arguments: JSON.stringify({ command: `pnpm vitest run src/case-${run}.test.ts` }),
        status: "done",
        output: [
          ` RUN  v5.0.5 /home/dev/orbit`,
          "",
          ...Array.from(
            { length: 10 },
            (value, line) => ` ✓ src/case-${run}.test.ts > case ${line + 1} passes`,
          ),
          "",
          ` Tests  ${10 + run} passed (${10 + run})`,
        ].join("\n"),
        diff: null,
      },
      {
        kind: "assistant-message",
        id: `solo-a-${run}`,
        text: `Case ${run} passes; moving on to the next one.`,
        streaming: false,
      },
    ];
  }).flat();
}

const REQUEST: ChatItem = {
  kind: "user-request",
  id: "q1",
  request: "select",
  title: "Which suite should I run next?",
  body: "The upload case passes. The other suites may still exercise the old body.",
  options: [
    { value: "all", label: "The whole suite", description: "Takes about two minutes" },
    { value: "upload", label: "Only the upload tests" },
  ],
  placeholder: null,
  prefill: null,
  expiresAt: null,
  status: "pending",
};

interface Fixture {
  readonly id: string;
  readonly label: string;
  readonly state: ChatSessionState;
  readonly items: readonly ChatItem[];
  /** Folds the host opens on mount, so the interesting body is visible at once. */
  readonly expanded: readonly string[];
}

const FIXTURES: readonly Fixture[] = [
  {
    id: "thinking",
    label: "Thinking",
    state: { ...BASE_STATE, turn: "working" },
    items: [PROMPT, REASONING_LIVE],
    expanded: [],
  },
  {
    id: "running",
    label: "Running a command",
    state: { ...BASE_STATE, turn: "working" },
    items: [PROMPT, REASONING_DONE, RUNNING, ANSWER_LIVE],
    expanded: ["t-run"],
  },
  {
    id: "finished",
    label: "Finished turn",
    state: { ...BASE_STATE, turn: "settled" },
    items: [PROMPT, REASONING_DONE, READ, RUN, EDIT, ANSWER],
    expanded: ["turn:u1", "group:t-read", "t-edit"],
  },
  {
    id: "write",
    label: "Wrote a file",
    state: { ...BASE_STATE, turn: "settled" },
    items: [PROMPT, WRITE, ANSWER],
    expanded: ["turn:u1", "t-write"],
  },
  {
    id: "several-files",
    label: "Several files",
    state: { ...BASE_STATE, turn: "settled" },
    items: [PROMPT, MULTI_EDIT, ANSWER],
    expanded: ["turn:u1", "t-nameless"],
  },
  {
    id: "long-command",
    label: "Long command",
    state: { ...BASE_STATE, turn: "settled" },
    items: [PROMPT, LONG_RUN],
    expanded: ["turn:u1", "t-long"],
  },
  {
    id: "failed",
    label: "Failed call",
    state: { ...BASE_STATE, turn: "error" },
    items: [PROMPT, FAILED, ERROR],
    expanded: ["t-run"],
  },
  {
    id: "long-call",
    label: "Long call",
    state: { ...BASE_STATE, turn: "settled" },
    items: [PROMPT, ...longCalls(), ANSWER],
    expanded: ["turn:u1", "solo-1", "solo-2", "solo-3"],
  },
  {
    id: "long-group",
    label: "Long group",
    state: { ...BASE_STATE, turn: "settled" },
    items: [PROMPT, ...longGroup(), ANSWER],
    expanded: ["turn:u1", "group:g-run-1", "g-run-3", "g-run-4"],
  },
  {
    id: "long-transcript",
    label: "Long transcript",
    state: { ...BASE_STATE, turn: "settled" },
    items: longTranscript(),
    expanded: [],
  },
  {
    id: "request",
    label: "Waiting on you",
    state: { ...BASE_STATE, turn: "working" },
    items: [PROMPT, READ, REQUEST],
    expanded: [],
  },
];

/** A frozen store: the review host has no server, so nothing ever pushes a new snapshot. */
function fixtureStore(state: ChatSessionState, items: readonly ChatItem[]): ChatStore {
  const snapshot: ChatStoreSnapshot = { loaded: true, sequence: 1, state, items, failure: null };
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    close: () => undefined,
  };
}

/** A transcript memory with the fixture's folds open; toggling still works, so the rows can be closed. */
function fixtureMemory(expanded: readonly string[]): ChatTranscriptStore {
  let memory = { anchor: undefined, atEnd: true, expanded: new Set(expanded) };
  return {
    read: () => memory,
    remember: () => undefined,
    toggle: (key) => {
      const next = new Set(memory.expanded);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      memory = { ...memory, expanded: next };
      return next;
    },
  };
}

export function ChatReview() {
  const [selected, setSelected] = useState(FIXTURES[0]?.id ?? "thinking");
  const [draft, setDraft] = useState("");
  const [dark, setDark] = useState(true);
  const [stores] = useState(
    () =>
      new Map(FIXTURES.map((fixture) => [fixture.id, fixtureStore(fixture.state, fixture.items)])),
  );
  const [memories] = useState(
    () => new Map(FIXTURES.map((fixture) => [fixture.id, fixtureMemory(fixture.expanded)])),
  );
  const fixture = FIXTURES.find((each) => each.id === selected) ?? FIXTURES[0];

  if (!import.meta.env.DEV) {
    return (
      <div className="visual-main-empty">
        <span className="visual-main-empty-title">Review host unavailable.</span>
        <span>This fixture host exists only in development builds.</span>
      </div>
    );
  }
  if (fixture === undefined) return null;
  const store = stores.get(fixture.id);
  const memory = memories.get(fixture.id);
  if (store === undefined || memory === undefined) return null;

  return (
    <div className="flex h-screen min-h-0 flex-col bg-canvas text-foreground">
      <div
        data-testid="chat-review-states"
        className="flex flex-wrap items-center gap-1 border-b border-border px-4 py-2"
      >
        {FIXTURES.map((each) => (
          <Button
            key={each.id}
            variant={each.id === fixture.id ? "outline" : "ghost"}
            size="sm"
            onClick={() => setSelected(each.id)}
          >
            {each.label}
          </Button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          Development fixtures; the server is not involved.
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <ChatView
          key={fixture.id}
          store={store}
          draft={draft}
          onDraftChange={setDraft}
          agent="claude"
          followUp
          canChooseAgent
          onSend={async () => undefined}
          aborting={false}
          onAbort={async () => undefined}
          onRespond={async () => undefined}
          onChangeModel={() => undefined}
          onChangeReasoning={() => undefined}
          files={NO_FILES}
          memory={memory}
          autoFocus={false}
        />
      </div>
      <div className="visual-review-theme">
        <VisualIconButton
          label={dark ? "Use light theme" : "Use dark theme"}
          icon="palette"
          onClick={() => {
            const next = !dark;
            setDark(next);
            document.documentElement.classList.toggle("dark", next);
          }}
        />
      </div>
    </div>
  );
}
