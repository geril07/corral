import type { ChatAnswer, ChatStreamMessage } from "@corral/protocol/chat";
import { DEFAULT_BINDINGS, DEFAULT_PREFIX, defaultClientConfig } from "@corral/protocol/config";
import type { ChatSendMode } from "@corral/protocol/rpc";
import { createConfigKeymap } from "@corral/client/prefix-keymap";
import { useCallback, useMemo } from "react";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { ChatView } from "./chat-view.tsx";
import { usePrefixMode } from "../keymap/index.ts";
import { prefixThen } from "../../../test/real-client.ts";
import {
  IDLE_CHAT,
  RECORDED_CHAT,
  RECORDED_SEQUENCE,
  longChat,
  recorded,
  scriptedChat,
  workingChat,
} from "../../../test/recorded-chat.ts";

const ABORT_HINT = `${DEFAULT_PREFIX} .`;

interface Sent {
  text: string;
  mode: ChatSendMode;
}

async function renderChat(messages: readonly ChatStreamMessage[] = RECORDED_CHAT) {
  const script = scriptedChat(messages);
  const sent: Sent[] = [];
  const responded: Array<{ requestId: string; value: ChatAnswer }> = [];
  const aborts: number[] = [];
  const screen = await render(
    <div className="h-screen w-full">
      <ChatView
        store={script.store}
        agent="pi"
        abortHint={ABORT_HINT}
        onSend={async (text, mode) => {
          sent.push({ text, mode });
        }}
        onAbort={async () => {
          aborts.push(Date.now());
        }}
        onRespond={async (requestId, value) => {
          responded.push({ requestId, value });
        }}
      />
    </div>,
  );
  return { ...screen, script, sent, responded, aborts };
}

test("renders a recorded stream: text, reasoning, folded tools, a diff, a notice, an error and a focused request", async () => {
  const chat = await renderChat();
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().sequence).toBe(RECORDED_SEQUENCE));

  // The pending request is last, owns the keyboard, and starts on its first option.
  await expect
    .element(page.getByRole("radiogroup", { name: "Which suite should I run next?" }))
    .toBeVisible();
  await expect.element(page.getByRole("radio", { name: "auth.test.ts" })).toHaveFocus();

  // User text is verbatim; the agent answer is Markdown with a highlighted code block and a list.
  await expect.element(page.getByText("The auth test is flaky on CI. Fix it.")).toBeVisible();
  await expect
    .element(page.getByRole("article", { name: "Agent message" }))
    .toMatchTextContent(/Waits on the condition instead of a fixed delay/);
  await expect.element(page.getByRole("listitem").first()).toMatchTextContent(/cookie write/);
  await vi.waitFor(() => {
    const token = document.querySelector("pre code span[style]");
    expect(token).not.toBeNull();
  });

  // Reasoning is one collapsed line that measured its own duration.
  await expect.element(page.getByRole("button", { name: /Thought/ })).toBeVisible();
  await expect
    .element(
      page.getByText("The test waits a fixed 50 ms for the cookie, then races the assertion."),
    )
    .not.toBeInTheDocument();

  // Three consecutive finished calls fold into one line; expanding shows each call.
  await expect.element(page.getByRole("button", { name: "3 tool calls" })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "3 tool calls" }));
  await expect
    .element(page.getByRole("button", { name: /^edit src\/auth\.test\.ts/ }))
    .toBeVisible();
  await userEvent.click(page.getByRole("button", { name: /^edit src\/auth\.test\.ts/ }));
  await expect.element(page.getByText("src/auth.test.ts").last()).toBeVisible();
  await vi.waitFor(() => expect(document.querySelector("diffs-container")).not.toBeNull());

  // A notice is a quiet line; an error is an alert.
  await expect.element(page.getByRole("note")).toMatchTextContent(/Compacted 12 earlier messages/);
  await expect
    .element(page.getByRole("alert").filter({ hasText: "The retry was refused once." }))
    .toBeVisible();
});

test("answers a request by keyboard and hands the keyboard back to the composer", async () => {
  const chat = await renderChat();
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().sequence).toBe(RECORDED_SEQUENCE));

  await expect.element(page.getByRole("radio", { name: "auth.test.ts" })).toHaveFocus();
  await userEvent.keyboard("{ArrowDown}{Enter}");

  expect(chat.responded).toEqual([{ requestId: "q1", value: "session" }]);
  await expect.element(page.getByRole("textbox", { name: "Message" })).toHaveFocus();

  // The server replaces the item in place with the recorded answer; it keeps its timeline slot.
  const request = chat.script.store
    .getSnapshot()
    .items.find((item) => item.kind === "user-request");
  if (request === undefined || request.kind !== "user-request")
    throw new Error("recorded request missing");
  chat.script.push({
    type: "event",
    sequence: (chat.script.store.getSnapshot().sequence ?? 0) + 1,
    event: { type: "item", item: { ...request, status: "answered", answer: "session" } },
  });
  await expect.element(page.getByText("Answered: session.test.ts")).toBeVisible();
  await expect.element(page.getByRole("radiogroup")).not.toBeInTheDocument();
});

test("an input request answers with Enter and a pending editor with Ctrl+Enter", async () => {
  const inputRequest = {
    kind: "user-request" as const,
    id: "q-input",
    request: "input" as const,
    title: "Commit message?",
    body: null,
    options: [],
    placeholder: "fix: auth test",
    prefill: null,
    expiresAt: null,
    status: "pending" as const,
  };
  const chat = await renderChat(recorded([{ type: "item", item: inputRequest }]));
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().sequence).toBe(1));

  const field = page.getByRole("textbox", { name: "Commit message?" });
  await expect.element(field).toHaveFocus();
  await userEvent.keyboard("fix: wait for the cookie{Enter}");
  expect(chat.responded).toEqual([{ requestId: "q-input", value: "fix: wait for the cookie" }]);

  const editorRequest = {
    ...inputRequest,
    id: "q-editor",
    request: "editor" as const,
    title: "Describe the change",
    placeholder: null,
  };
  chat.script.push(
    {
      type: "event",
      sequence: 2,
      event: {
        type: "item",
        item: { ...inputRequest, status: "answered", answer: "fix: wait for the cookie" },
      },
    },
    { type: "event", sequence: 3, event: { type: "item", item: editorRequest } },
  );
  const editor = page.getByRole("textbox", { name: "Describe the change" });
  await expect.element(editor).toHaveFocus();
  await userEvent.keyboard("First line{Enter}Second line");
  expect(chat.responded).toHaveLength(1);
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await vi.waitFor(() =>
    expect(chat.responded[1]).toEqual({ requestId: "q-editor", value: "First line\nSecond line" }),
  );
});

test("send, steer and queue a follow-up from the keyboard; Shift+Enter is a newline", async () => {
  const chat = await renderChat(recorded([], { state: IDLE_CHAT }));
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect.element(composer).toHaveFocus();
  await expect.element(page.getByText("Enter send · Shift+Enter newline")).toBeVisible();

  await userEvent.keyboard("Fix the test{Enter}");
  await vi.waitFor(() => expect(chat.sent).toEqual([{ text: "Fix the test", mode: "prompt" }]));
  await expect.element(composer).toHaveValue("");

  // The server's stream accepts the prompt and starts the turn.
  chat.script.push(
    {
      type: "event",
      sequence: 1,
      event: { type: "item", item: { kind: "user-message", id: "u-live", text: "Fix the test" } },
    },
    { type: "event", sequence: 2, event: { type: "state", state: workingChat() } },
  );
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().state.turn).toBe("working"));
  await expect.element(page.getByText(/Enter steer · ⌘\/Ctrl\+Enter follow-up/)).toBeVisible();

  await userEvent.keyboard("Tighten the assertion{Enter}");
  await vi.waitFor(() =>
    expect(chat.sent[1]).toEqual({ text: "Tighten the assertion", mode: "steer" }),
  );

  await userEvent.keyboard("Then run lint{Control>}{Enter}{/Control}");
  await vi.waitFor(() =>
    expect(chat.sent[2]).toEqual({ text: "Then run lint", mode: "follow-up" }),
  );

  // Steering and queued messages are the session's state, so the composer shows them.
  chat.script.push({
    type: "event",
    sequence: 3,
    event: {
      type: "state",
      state: workingChat({ steering: ["Tighten the assertion"], followUp: ["Then run lint"] }),
    },
  });
  await expect.element(page.getByText("Steering: Tighten the assertion")).toBeVisible();
  await expect.element(page.getByText("Queued: Then run lint")).toBeVisible();

  await userEvent.keyboard("line one{Shift>}{Enter}{/Shift}line two");
  await expect.element(composer).toHaveValue("line one\nline two");
  expect(chat.sent).toHaveLength(3);
});

function PrefixHarness({
  store,
  onAbort,
  onAction,
}: {
  store: ReturnType<typeof scriptedChat>["store"];
  onAbort: () => Promise<void>;
  onAction: (action: string) => void;
}) {
  const config = useMemo(
    () => ({
      ...defaultClientConfig(""),
      keys: { prefix: DEFAULT_PREFIX, bindings: { ...DEFAULT_BINDINGS } },
    }),
    [],
  );
  const keymap = useMemo(() => createConfigKeymap(config), [config]);
  const handle = useCallback(
    (action: string) => {
      onAction(action);
      if (action === "abort-turn") void onAbort();
    },
    [onAbort, onAction],
  );
  usePrefixMode(keymap, handle, true);
  return (
    <div className="h-screen w-full">
      <ChatView
        store={store}
        agent="pi"
        abortHint={ABORT_HINT}
        onSend={async () => {}}
        onAbort={onAbort}
        onRespond={async () => {}}
      />
    </div>
  );
}

test("prefix mode works while the composer has the keyboard: prefix . aborts and plain keys stay in the field", async () => {
  const script = scriptedChat(recorded([], { state: workingChat() }));
  const actions: string[] = [];
  const aborts: number[] = [];
  await render(
    <PrefixHarness
      store={script.store}
      onAction={(action) => actions.push(action)}
      onAbort={async () => {
        aborts.push(Date.now());
      }}
    />,
  );
  await vi.waitFor(() => expect(script.store.getSnapshot().loaded).toBe(true));
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect.element(composer).toHaveFocus();
  await userEvent.keyboard("keep this");
  await expect.element(composer).toHaveValue("keep this");

  // The window capture-phase handler sees the chord before the textarea and takes the dot.
  await prefixThen(".");
  await vi.waitFor(() => expect(aborts).toHaveLength(1));
  expect(actions).toContain("abort-turn");
  await expect.element(composer).toHaveValue("keep this");

  // The composer still owns plain keys after the chord.
  await userEvent.keyboard("!");
  await expect.element(composer).toHaveValue("keep this!");
  script.close();
});

/** The scrollable node LegendList owns, wherever it nests it under its test id. */
function scrollNode(): HTMLElement {
  const root = document.querySelector<HTMLElement>('[data-testid="chat-timeline"]');
  if (root === null) throw new Error("chat timeline missing");
  const candidates = [root, ...root.querySelectorAll<HTMLElement>("*")];
  const node = candidates.find(
    (element) => element.scrollHeight > element.clientHeight + 4 && element.clientHeight > 0,
  );
  if (node === undefined) throw new Error("chat timeline has no scrollable node");
  return node;
}

const atEnd = (node: HTMLElement) => node.scrollTop + node.clientHeight >= node.scrollHeight - 12;

test("auto-scroll follows the stream at the end and stays put after the user scrolls up", async () => {
  const chat = await renderChat(longChat(80));
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  await vi.waitFor(() => expect(atEnd(scrollNode())).toBe(true));

  const node = scrollNode();
  const before = node.scrollTop;
  await userEvent.wheel(page.getByTestId("chat-timeline"), { delta: { y: -1200 } });
  await vi.waitFor(() => expect(scrollNode().scrollTop).toBeLessThan(before - 100));

  chat.script.push({
    type: "event",
    sequence: 1,
    event: { type: "item", item: { kind: "notice", id: "n-live", text: "A new line arrives." } },
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().sequence).toBe(1));
  // The new row is offscreen because the view stayed where the user left it.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  expect(scrollNode().scrollTop).toBeLessThan(before - 100);

  // Back at the end, the follow resumes for the next update.
  await userEvent.wheel(page.getByTestId("chat-timeline"), { delta: { y: 100_000 } });
  await vi.waitFor(() => expect(atEnd(scrollNode())).toBe(true));
  chat.script.push({
    type: "event",
    sequence: 2,
    event: {
      type: "item",
      item: { kind: "user-message", id: "u-live", text: "After the scroll." },
    },
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().sequence).toBe(2));
  await vi.waitFor(() => expect(atEnd(scrollNode())).toBe(true));
});

for (const size of [500, 2000, 5000, 10_000]) {
  test(
    `a ${size}-item transcript stays virtualized and a streamed delta stays responsive`,
    { timeout: 60_000 },
    async () => {
      const chat = await renderChat(longChat(size));
      await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
      const itemId = `long-${size - 1}`;
      // The list opens at the end, so the streaming answer is mounted before it is measured.
      await vi.waitFor(() =>
        expect(document.body.textContent).toContain(`Short answer ${size - 1}.`),
      );

      const samples: number[] = [];
      let sequence = 0;
      for (let index = 0; index < 20; index += 1) {
        // One update at a time: the sample is the time this delta took to reach the screen.
        sequence += 1;
        const start = performance.now();
        chat.script.push({
          type: "event",
          sequence,
          event: { type: "delta", itemId, text: " more" },
        });
        // oxlint-disable-next-line eslint/no-await-in-loop -- one measured update at a time
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        samples.push(performance.now() - start);
      }
      samples.sort((left, right) => left - right);
      const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? 0;
      const max = samples[samples.length - 1] ?? 0;
      const mounted = document.querySelectorAll('article[aria-label="Agent message"]').length;
      // The measured numbers belong in the slice report; a log line keeps them in the gate log.
      console.log(JSON.stringify({ size, p95, max, mounted }));
      expect(mounted).toBeLessThan(100);
      expect(p95).toBeLessThan(100);
      chat.script.close();
    },
  );
}

test("a refused watch shows the store's failure and the view does not retry it in a loop", async () => {
  const { ORPCError } = await import("@orpc/client");
  const { createChatStore } = await import("@corral/client/chat-store");
  const { Store } = await import("@corral/client/store");
  let attempts = 0;
  const source = {
    state: new Store({ status: "connected" as const }),
    watch: () => {
      attempts += 1;
      return Promise.reject(
        new ORPCError("CHAT_UNAVAILABLE", {
          defined: true,
          data: { message: "This build has no chat driver for pi.", reason: "no-driver" },
        }),
      );
    },
  };
  const store = createChatStore(source, "session-refused");
  await render(
    <div className="h-screen w-full">
      <ChatView
        store={store}
        agent="pi"
        abortHint={ABORT_HINT}
        onSend={async () => {}}
        onAbort={async () => {}}
        onRespond={async () => {}}
      />
    </div>,
  );
  await expect.element(page.getByText("This build has no chat driver for pi.")).toBeVisible();
  // The store retries once per connection change, then waits: two attempts, not a loop.
  await vi.waitFor(() => expect(attempts).toBe(2));
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(attempts).toBe(2);
  store.close();
});
