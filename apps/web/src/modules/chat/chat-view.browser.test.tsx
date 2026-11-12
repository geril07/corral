import type { ChatAnswer, ChatItem, ChatStreamMessage } from "@corral/protocol/chat";
import {
  DEFAULT_BINDINGS,
  DEFAULT_DIRECT_BINDINGS,
  DEFAULT_PREFIX,
  defaultClientConfig,
} from "@corral/protocol/config";
import type { ChatSendMode } from "@corral/protocol/rpc";
import { createConfigKeymap } from "@corral/client/prefix-keymap";
import { useCallback, useMemo, useState } from "react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { ChatViewHarness as ChatView } from "../../../test/chat-view-harness.tsx";
import { measureTranscriptPerf } from "../../../test/chat-transcript-perf.tsx";
import { stubClipboard } from "../../../test/clipboard.ts";
import type { ChatFiles } from "./local-links.tsx";
import { chatTranscriptStore, type ChatTranscriptStore } from "./chat-transcript.ts";
import { chatRows } from "./chat-rows.ts";
import { TranscriptRow } from "./chat-items.tsx";
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

/** Chat links in these tests: nothing resolves, nothing opens (the lane's own file covers links). */
const NO_FILES: ChatFiles = {
  resolve: async () => [],
  read: async () => {
    throw new Error("no file reads in this test");
  },
  open: async () => undefined,
};

/** Chromium's media emulation is the only way to change what a CSS media query sees. */
async function emulateMotion(reducedMotion: "no-preference" | "reduce") {
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: reducedMotion }],
  });
}

/** Every scripted watch this file opened; closing them ends the iterators before the next file. */
const chats: Array<ReturnType<typeof scriptedChat>> = [];
afterEach(async () => {
  for (const chat of chats.splice(0)) chat.close();
  // Clearing the feature list restores the host preference instead of emulating the default.
  await cdp().send("Emulation.setEmulatedMedia", { features: [] });
});

interface Sent {
  text: string;
  mode: ChatSendMode;
}

interface ChatActionHooks {
  onSend?: (text: string, mode: ChatSendMode) => Promise<void>;
  onAbort?: () => Promise<void>;
}

async function renderChat(
  messages: readonly ChatStreamMessage[] = RECORDED_CHAT,
  hooks: ChatActionHooks = {},
  options: { followUp?: boolean | undefined; memory?: ChatTranscriptStore } = { followUp: true },
) {
  const script = scriptedChat(messages);
  chats.push(script);
  const sent: Sent[] = [];
  const responded: Array<{ requestId: string; value: ChatAnswer }> = [];
  const aborts: number[] = [];
  const openModel = vi.fn<() => void>();
  const openReasoning = vi.fn<() => void>();
  const screen = await render(
    <div className="h-screen w-full">
      <ChatView
        store={script.store}
        agent="pi"
        followUp={options.followUp}
        files={NO_FILES}
        abortHint={ABORT_HINT}
        {...(options.memory === undefined ? {} : { memory: options.memory })}
        onSend={async (text, mode) => {
          sent.push({ text, mode });
          await hooks.onSend?.(text, mode);
        }}
        onAbort={async () => {
          aborts.push(Date.now());
          await hooks.onAbort?.();
        }}
        onRespond={async (requestId, value) => {
          responded.push({ requestId, value });
        }}
        onChangeModel={openModel}
        onChangeReasoning={openReasoning}
      />
    </div>,
  );
  return { ...screen, script, sent, responded, aborts, openModel, openReasoning };
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

  // Reasoning is one collapsed row, `Thought` once it is no longer streaming.
  await expect.element(page.getByRole("button", { name: /Thought/ })).toBeVisible();
  await expect
    .element(
      page.getByText("The test waits a fixed 50 ms for the cookie, then races the assertion."),
    )
    .not.toBeInTheDocument();

  // Three consecutive finished calls fold into one verb summary; expanding shows each call.
  const group = page.getByRole("button", { name: /^Ran 1 command, changed 1 file/ });
  await expect.element(group).toBeVisible();
  await userEvent.click(group);
  await expect.element(page.getByRole("button", { name: /^Changed 1 file$/ })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: /^Changed 1 file$/ }));
  await expect.element(page.getByText("src/auth.test.ts").last()).toBeVisible();
  // The diff is a real rendered diff, not just a `diffs-container` error shell: the shadow root
  // carries the addition and deletion rows with their `+`/`-` gutter markers.
  const shadow = await vi.waitFor(() => {
    const root = document.querySelector("diffs-container")?.shadowRoot;
    if (root === null || root === undefined) throw new Error("the diff has not rendered yet");
    return root;
  });
  await vi.waitFor(() =>
    expect(shadow.querySelectorAll("[data-line-type][data-line]").length).toBeGreaterThan(0),
  );
  const added = [...shadow.querySelectorAll('[data-line-type="change-addition"][data-line]')];
  const removed = [...shadow.querySelectorAll('[data-line-type="change-deletion"][data-line]')];
  expect(added.some((node) => node.textContent?.includes("vi.waitFor"))).toBe(true);
  expect(removed.some((node) => node.textContent?.includes("setTimeout"))).toBe(true);
  expect(getComputedStyle(added[0]!, "::before").content).toBe('"+"');
  expect(getComputedStyle(removed[0]!, "::before").content).toBe('"-"');

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

test("a select with no options is still answerable: Dismiss takes focus and Enter responds null", async () => {
  const empty = {
    kind: "user-request" as const,
    id: "q-empty",
    request: "select" as const,
    title: "Pick one",
    body: "The driver offered no options.",
    options: [],
    placeholder: null,
    prefill: null,
    expiresAt: null,
    status: "pending" as const,
  };
  const chat = await renderChat(recorded([{ type: "item", item: empty }]));
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().sequence).toBe(1));

  const dismiss = page.getByRole("button", { name: "Dismiss" });
  await expect.element(dismiss).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(chat.responded).toEqual([{ requestId: "q-empty", value: null }]));
  await expect.element(page.getByRole("textbox", { name: "Message" })).toHaveFocus();
});

test("a deferred pointer send keeps the keyboard in the composer", async () => {
  const pending = Promise.withResolvers<void>();
  const chat = await renderChat(recorded([], { state: IDLE_CHAT }), {
    onSend: () => pending.promise,
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  const composer = page.getByRole("textbox", { name: "Message" });
  const send = page.getByRole("button", { name: "Send" });
  await expect.element(composer).toHaveFocus();
  await userEvent.keyboard("Fix the test");

  await userEvent.click(send);
  await vi.waitFor(() => expect(chat.sent).toEqual([{ text: "Fix the test", mode: "prompt" }]));
  // The press does not focus the button, so disabling it cannot drop focus to <body>.
  await expect.element(send).toBeDisabled();
  await expect.element(composer).toHaveFocus();
  await expect.element(send).not.toHaveFocus();
  await userEvent.keyboard(" now");
  await expect.element(composer).toHaveValue("Fix the test now");

  pending.resolve();
  await expect.element(send).toBeEnabled();
  await expect.element(composer).toHaveFocus();
});

test("a deferred pointer send leaves focus outside the composer alone", async () => {
  const pending = Promise.withResolvers<void>();
  const chat = await renderChat(recorded([], { state: IDLE_CHAT }), {
    onSend: () => pending.promise,
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  const composer = page.getByRole("textbox", { name: "Message" });
  const send = page.getByRole("button", { name: "Send" });
  const log = page.getByRole("log", { name: "Chat transcript" });
  await expect.element(composer).toHaveFocus();
  await userEvent.keyboard("Fix the test");

  // The user left the composer deliberately before pressing Send with the pointer.
  log.element().focus();
  await expect.element(log).toHaveFocus();
  await userEvent.click(send);
  await vi.waitFor(() => expect(chat.sent).toEqual([{ text: "Fix the test", mode: "prompt" }]));
  await expect.element(send).toBeDisabled();
  await expect.element(log).toHaveFocus();
  await expect.element(composer).not.toHaveFocus();

  pending.resolve();
  await expect.element(composer).toHaveValue("");
  await expect.element(log).toHaveFocus();
  await expect.element(composer).not.toHaveFocus();
});

test("a deferred keyboard send returns the keyboard to the composer", async () => {
  const pending = Promise.withResolvers<void>();
  const chat = await renderChat(recorded([], { state: IDLE_CHAT }), {
    onSend: () => pending.promise,
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  const composer = page.getByRole("textbox", { name: "Message" });
  const send = page.getByRole("button", { name: "Send" });
  await expect.element(composer).toHaveFocus();
  await userEvent.keyboard("Fix the test");

  // The disabled model row is skipped; Thinking is enabled and comes before Send.
  await userEvent.keyboard("{Tab}{Tab}");
  await expect.element(send).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(chat.sent).toEqual([{ text: "Fix the test", mode: "prompt" }]));
  // The focused button hands the keyboard back before the action disables it.
  await expect.element(send).toBeDisabled();
  await expect.element(composer).toHaveFocus();
  await userEvent.keyboard(" now");
  await expect.element(composer).toHaveValue("Fix the test now");

  pending.resolve();
  await expect.element(send).toBeEnabled();
  await expect.element(composer).toHaveFocus();
});

test("a deferred send does not pull focus back from where the user moved it", async () => {
  const pending = Promise.withResolvers<void>();
  const chat = await renderChat(recorded([], { state: IDLE_CHAT }), {
    onSend: () => pending.promise,
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  const composer = page.getByRole("textbox", { name: "Message" });
  const send = page.getByRole("button", { name: "Send" });
  const log = page.getByRole("log", { name: "Chat transcript" });
  await expect.element(composer).toHaveFocus();
  await userEvent.keyboard("Fix the test");

  // The disabled model row is skipped; Thinking is enabled and comes before Send.
  await userEvent.keyboard("{Tab}{Tab}");
  await expect.element(send).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(chat.sent).toEqual([{ text: "Fix the test", mode: "prompt" }]));
  await expect.element(composer).toHaveFocus();

  // The send is still pending; a deliberate move must survive it settling.
  log.element().focus();
  await expect.element(log).toHaveFocus();
  pending.resolve();
  await expect.element(composer).toHaveValue("");
  await expect.element(log).toHaveFocus();
});

test("an accepted send keeps text typed while it was in flight and the next Enter sends only that", async () => {
  const pending = Promise.withResolvers<void>();
  const chat = await renderChat(recorded([], { state: IDLE_CHAT }), {
    onSend: () => pending.promise,
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect.element(composer).toHaveFocus();
  await userEvent.keyboard("Fix the test{Enter}");
  await vi.waitFor(() => expect(chat.sent).toEqual([{ text: "Fix the test", mode: "prompt" }]));
  await expect.element(composer).toHaveValue("Fix the test");

  await userEvent.keyboard(" and run lint");
  await expect.element(composer).toHaveValue("Fix the test and run lint");

  pending.resolve();
  // Acceptance removes only the submitted snapshot; the text typed since stays.
  await expect.element(composer).toHaveValue(" and run lint");

  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(chat.sent[1]).toEqual({ text: "and run lint", mode: "prompt" }));
  await expect.element(composer).toHaveValue("");
});

test("a leading-space draft removes its raw snapshot and sends only an in-flight append", async () => {
  const pending = Promise.withResolvers<void>();
  const chat = await renderChat(recorded([], { state: IDLE_CHAT }), {
    onSend: () => pending.promise,
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect.element(composer).toHaveFocus();
  await composer.fill("  Fix the test  ");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(chat.sent).toEqual([{ text: "Fix the test", mode: "prompt" }]));
  await expect.element(composer).toHaveFocus();

  await userEvent.keyboard(" and run lint");
  await expect.element(composer).toHaveValue("  Fix the test   and run lint");
  pending.resolve();
  // The raw snapshot is what acceptance removes; trimming it would keep the whole draft here.
  await expect.element(composer).toHaveValue(" and run lint");

  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(chat.sent[1]).toEqual({ text: "and run lint", mode: "prompt" }));
});

test("a whitespace-only edit during a send is kept and does not send", async () => {
  const pending = Promise.withResolvers<void>();
  const chat = await renderChat(recorded([], { state: IDLE_CHAT }), {
    onSend: () => pending.promise,
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect.element(composer).toHaveFocus();
  await userEvent.keyboard("Fix the test{Enter}");
  await vi.waitFor(() => expect(chat.sent).toEqual([{ text: "Fix the test", mode: "prompt" }]));
  await expect.element(composer).toHaveFocus();

  await userEvent.keyboard(" ");
  await expect.element(composer).toHaveValue("Fix the test ");
  pending.resolve();
  await expect.element(composer).toHaveValue(" ");

  await userEvent.keyboard("{Enter}");
  expect(chat.sent).toHaveLength(1);
});

test("a draft edited in place during a send keeps its whole text", async () => {
  const pending = Promise.withResolvers<void>();
  const chat = await renderChat(recorded([], { state: IDLE_CHAT }), {
    onSend: () => pending.promise,
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect.element(composer).toHaveFocus();
  await userEvent.keyboard("Fix the test{Enter}");
  await vi.waitFor(() => expect(chat.sent).toEqual([{ text: "Fix the test", mode: "prompt" }]));
  await expect.element(composer).toHaveFocus();

  await composer.fill("Fix this test");
  pending.resolve();
  await expect.element(composer).toHaveValue("Fix this test");

  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(chat.sent[1]).toEqual({ text: "Fix this test", mode: "prompt" }));
});

test("a refused send keeps the whole draft and shows its sentence", async () => {
  const pending = Promise.withResolvers<void>();
  const chat = await renderChat(recorded([], { state: IDLE_CHAT }), {
    onSend: async () => {
      await pending.promise;
      throw new Error("The agent refused the send.");
    },
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  const composer = page.getByRole("textbox", { name: "Message" });
  const send = page.getByRole("button", { name: "Send" });
  await expect.element(composer).toHaveFocus();
  await userEvent.keyboard("Fix the test{Enter}");
  await vi.waitFor(() => expect(chat.sent).toEqual([{ text: "Fix the test", mode: "prompt" }]));
  await userEvent.keyboard(" and run lint");

  pending.resolve();
  await expect.element(page.getByRole("alert")).toHaveTextContent("The agent refused the send.");
  await expect.element(composer).toHaveValue("Fix the test and run lint");
  await expect.element(send).toBeEnabled();
});

test("a deferred pointer queue keeps the keyboard in the composer", async () => {
  const pending = Promise.withResolvers<void>();
  const chat = await renderChat(recorded([], { state: workingChat() }), {
    onSend: () => pending.promise,
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  const composer = page.getByRole("textbox", { name: "Message" });
  const queue = page.getByRole("button", { name: "Queue" });
  await expect.element(composer).toHaveFocus();
  await userEvent.keyboard("Queue this");

  await userEvent.click(queue);
  await vi.waitFor(() => expect(chat.sent).toEqual([{ text: "Queue this", mode: "follow-up" }]));
  await expect.element(queue).toBeDisabled();
  await expect.element(composer).toHaveFocus();
  await expect.element(queue).not.toHaveFocus();
  await userEvent.keyboard(" now");
  await expect.element(composer).toHaveValue("Queue this now");

  pending.resolve();
  await expect.element(queue).toBeEnabled();
  await expect.element(composer).toHaveFocus();
});

test("a deferred keyboard queue returns the keyboard to the composer", async () => {
  const pending = Promise.withResolvers<void>();
  const chat = await renderChat(recorded([], { state: workingChat() }), {
    onSend: () => pending.promise,
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  const composer = page.getByRole("textbox", { name: "Message" });
  const queue = page.getByRole("button", { name: "Queue" });
  await expect.element(composer).toHaveFocus();
  await userEvent.keyboard("Queue this");

  // The disabled model row is skipped; Thinking comes before Queue in the toolbar.
  await userEvent.keyboard("{Tab}{Tab}");
  await expect.element(queue).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(chat.sent).toEqual([{ text: "Queue this", mode: "follow-up" }]));
  await expect.element(queue).toBeDisabled();
  await expect.element(composer).toHaveFocus();
  await userEvent.keyboard(" now");
  await expect.element(composer).toHaveValue("Queue this now");

  pending.resolve();
  await expect.element(queue).toBeEnabled();
  await expect.element(composer).toHaveFocus();
});

test("a deferred pointer abort keeps the keyboard in the composer", async () => {
  const pending = Promise.withResolvers<void>();
  const chat = await renderChat(recorded([], { state: workingChat() }), {
    onAbort: () => pending.promise,
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  const composer = page.getByRole("textbox", { name: "Message" });
  const abort = page.getByRole("button", { name: "Abort" });
  await expect.element(composer).toHaveFocus();

  await userEvent.click(abort);
  await vi.waitFor(() => expect(chat.aborts).toHaveLength(1));
  const stopping = page.getByRole("button", { name: "Stopping…" });
  await expect.element(stopping).toBeDisabled();
  await expect.element(composer).toHaveFocus();
  await expect.element(stopping).not.toHaveFocus();
  await userEvent.keyboard("still typing");
  await expect.element(composer).toHaveValue("still typing");

  pending.resolve();
  await expect.element(page.getByRole("button", { name: "Abort" })).toBeEnabled();
  await expect.element(composer).toHaveFocus();
});

test("a deferred keyboard abort returns the keyboard to the composer", async () => {
  const pending = Promise.withResolvers<void>();
  const chat = await renderChat(recorded([], { state: workingChat() }), {
    onAbort: () => pending.promise,
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  const composer = page.getByRole("textbox", { name: "Message" });
  const abort = page.getByRole("button", { name: "Abort" });
  await expect.element(composer).toHaveFocus();
  await userEvent.keyboard("Keep this");

  // A draft keeps Queue enabled, so the toolbar tab order is Thinking, Queue, then Abort.
  await userEvent.keyboard("{Tab}{Tab}");
  await expect.element(page.getByRole("button", { name: "Queue" })).toHaveFocus();
  await userEvent.keyboard("{Tab}");
  await expect.element(abort).toHaveFocus();
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(chat.aborts).toHaveLength(1));
  const stopping = page.getByRole("button", { name: "Stopping…" });
  await expect.element(stopping).toBeDisabled();
  await expect.element(composer).toHaveFocus();
  await userEvent.keyboard(" text");
  await expect.element(composer).toHaveValue("Keep this text");

  pending.resolve();
  await expect.element(page.getByRole("button", { name: "Abort" })).toBeEnabled();
  await expect.element(composer).toHaveFocus();
});

test("a pending abort says it is stopping and marks the composer row busy", async () => {
  const pending = Promise.withResolvers<void>();
  const chat = await renderChat(recorded([], { state: workingChat() }), {
    onAbort: () => pending.promise,
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  const composer = page.getByRole("textbox", { name: "Message" });
  const queue = page.getByRole("button", { name: "Queue" });
  const steer = page.getByRole("button", { name: "Steer" });
  const abort = page.getByRole("button", { name: "Abort" });
  const row = abort.element().parentElement!;
  await expect.element(composer).toHaveFocus();
  await userEvent.keyboard("Keep this");

  await userEvent.click(abort);
  await vi.waitFor(() => expect(chat.aborts).toHaveLength(1));

  // The visible label and the accessible name both say what is happening; the row is busy.
  const stopping = page.getByRole("button", { name: "Stopping…" });
  await expect.element(stopping).toBeDisabled();
  await expect.element(stopping).toHaveTextContent("Stopping…");
  await expect.poll(() => row.getAttribute("aria-busy")).toBe("true");

  // The turn still reads working and the other actions keep their own rules.
  await expect.element(page.getByText(/Enter steer · ⌘\/Ctrl\+Enter follow-up/)).toBeVisible();
  await expect.element(queue).toBeEnabled();
  await expect.element(steer).toBeEnabled();

  pending.resolve();
  await expect.element(page.getByRole("button", { name: "Abort" })).toBeEnabled();
  await expect.poll(() => row.getAttribute("aria-busy")).toBe("false");
  await expect.element(queue).toBeEnabled();
  await expect.element(steer).toBeEnabled();
});

test("a rejected abort clears the stopping state and shows its sentence", async () => {
  const pending = Promise.withResolvers<void>();
  const chat = await renderChat(recorded([], { state: workingChat() }), {
    onAbort: async () => {
      await pending.promise;
      throw new Error("The agent refused the abort.");
    },
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  const abort = page.getByRole("button", { name: "Abort" });
  const row = abort.element().parentElement!;

  await userEvent.click(abort);
  await vi.waitFor(() => expect(chat.aborts).toHaveLength(1));
  await expect.element(page.getByRole("button", { name: "Stopping…" })).toBeDisabled();
  await expect.poll(() => row.getAttribute("aria-busy")).toBe("true");

  pending.resolve();
  await expect.element(page.getByRole("alert")).toHaveTextContent("The agent refused the abort.");
  await expect.element(page.getByRole("button", { name: "Abort" })).toBeEnabled();
  await expect.poll(() => row.getAttribute("aria-busy")).toBe("false");
});

test("a driver without follow-up hides Queue and turns Ctrl/Cmd+Enter into steer", async () => {
  const chat = await renderChat(recorded([], { state: workingChat() }), {}, { followUp: false });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect.element(composer).toHaveFocus();

  // Codex's declaration: no Queue and no follow-up clause in the hint, abort still named.
  await expect.element(page.getByRole("button", { name: "Queue" })).not.toBeInTheDocument();
  await expect.element(page.getByText(`Enter steer · ${ABORT_HINT} abort`)).toBeVisible();
  await expect.element(page.getByText(/follow-up/)).not.toBeInTheDocument();

  // Plain Enter still steers; the chord is the same action rather than a refused follow-up.
  await userEvent.keyboard("Steer this{Enter}");
  await vi.waitFor(() => expect(chat.sent).toEqual([{ text: "Steer this", mode: "steer" }]));
  await userEvent.keyboard("And this{Control>}{Enter}{/Control}");
  await vi.waitFor(() => expect(chat.sent[1]).toEqual({ text: "And this", mode: "steer" }));
});

test("an unanswered driver capability keeps the follow-up offer", async () => {
  // `undefined` is the store before its answer, or an agent without a record: not a refusal.
  const chat = await renderChat(recorded([], { state: workingChat() }), {}, {});
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect.element(composer).toHaveFocus();

  await expect.element(page.getByRole("button", { name: "Queue" })).toBeVisible();
  await expect.element(page.getByText(/Enter steer · ⌘\/Ctrl\+Enter follow-up/)).toBeVisible();

  await userEvent.keyboard("Queue this{Control>}{Enter}{/Control}");
  await vi.waitFor(() => expect(chat.sent).toEqual([{ text: "Queue this", mode: "follow-up" }]));
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
      keys: {
        prefix: DEFAULT_PREFIX,
        bindings: { ...DEFAULT_BINDINGS },
        direct: { ...DEFAULT_DIRECT_BINDINGS },
      },
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
  const [memory] = useState(chatTranscriptStore);
  return (
    // Swallow keydown at the bubble phase: only a capture-phase handler can still see the chord.
    <div className="h-screen w-full" onKeyDown={(event) => event.stopPropagation()}>
      <ChatView
        store={store}
        agent="pi"
        followUp={true}
        files={NO_FILES}
        abortHint={ABORT_HINT}
        memory={memory}
        onSend={async () => {}}
        onAbort={onAbort}
        onRespond={async () => {}}
        onChangeModel={() => {}}
        onChangeReasoning={() => {}}
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

/** The row under the top edge of the transcript: the one the user was reading. */
function topRowKey(): string | undefined {
  const node = scrollNode();
  const box = node.getBoundingClientRect();
  return [...node.querySelectorAll<HTMLElement>("[data-row-key]")].find(
    (row) => row.getBoundingClientRect().bottom > box.top + 1,
  )?.dataset["rowKey"];
}

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
  await userEvent.wheel(page.getByTestId("chat-timeline"), { delta: { y: 2000 }, times: 10 });
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

test.each([
  { name: "fully offscreen", delta: -3000, tailMounted: false },
  { name: "in overscan", delta: -100, tailMounted: true },
])(
  "a request arriving $name reveals itself, takes focus and can be answered",
  async ({ delta, tailMounted }) => {
    const chat = await renderChat(longChat(80));
    await vi.waitFor(() => expect(atEnd(scrollNode())).toBe(true));
    await userEvent.wheel(page.getByTestId("chat-timeline"), { delta: { y: delta } });
    await vi.waitFor(() => expect(atEnd(scrollNode())).toBe(false));
    expect(scrollNode().querySelector('[data-row-key="long-79"]') !== null).toBe(tailMounted);
    const request = {
      kind: "user-request" as const,
      id: "history-request",
      request: "confirm" as const,
      title: "Proceed?",
      body: null,
      options: [],
      placeholder: null,
      prefill: null,
      expiresAt: null,
      status: "pending" as const,
    };
    chat.script.push({
      type: "event",
      sequence: 1,
      event: { type: "item", item: request },
    });
    const yes = page.getByRole("radio", { name: "Yes" });
    await expect.element(yes).toHaveFocus();
    await vi.waitFor(() => {
      const viewport = scrollNode().getBoundingClientRect();
      const control = yes.element().getBoundingClientRect();
      expect(control.top).toBeGreaterThanOrEqual(viewport.top);
      expect(control.bottom).toBeLessThanOrEqual(viewport.bottom);
      expect(control.bottom).toBeLessThanOrEqual(
        page.getByRole("textbox", { name: "Message" }).element().getBoundingClientRect().top,
      );
    });
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(chat.responded).toEqual([{ requestId: "history-request", value: true }]),
    );
    chat.script.push({
      type: "event",
      sequence: 2,
      event: { type: "item", item: { ...request, status: "answered", answer: true } },
    });
    await expect.element(page.getByRole("textbox", { name: "Message" })).toHaveFocus();
    await expect.element(page.getByText("Answered: Yes")).toBeVisible();
  },
);

test.each(["working", "settled"] as const)(
  "answering the newest request reveals an older pending request in a %s transcript",
  async (turn) => {
    const older = {
      kind: "user-request" as const,
      id: "older-request",
      request: "confirm" as const,
      title: "Older permission",
      body: null,
      options: [],
      placeholder: null,
      prefill: null,
      expiresAt: null,
      status: "pending" as const,
    };
    const newest = { ...older, id: "newer-request", title: "Newer permission" };
    const items: ChatItem[] = [
      { kind: "user-message", id: "old-prompt", text: "Start" },
      READ("fold-work", "older.ts"),
      ...Array.from({ length: 35 }, (_, index): ChatItem => ({
        kind: "notice",
        id: `old-before-${index}`,
        text: `Before permission ${index}`,
      })),
      older,
      ...Array.from({ length: 35 }, (_, index): ChatItem => ({
        kind: "notice",
        id: `old-after-${index}`,
        text: `After permission ${index}`,
      })),
      ...Array.from({ length: 40 }, (_, index): ChatItem => ({
        kind: "user-message",
        id: `later-${index}`,
        text: `Later prompt ${index}`,
      })),
      newest,
    ];
    const chat = await renderChat(recorded([], { state: { ...IDLE_CHAT, turn }, items }));
    const newerYes = page
      .getByRole("radiogroup", { name: "Newer permission" })
      .getByRole("radio", { name: "Yes" });
    await expect.element(newerYes).toHaveFocus();
    expect(page.getByRole("radiogroup", { name: "Older permission" }).elements()).toHaveLength(0);
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(chat.responded).toEqual([{ requestId: "newer-request", value: true }]),
    );
    chat.script.push({
      type: "event",
      sequence: 1,
      event: { type: "item", item: { ...newest, status: "answered", answer: true } },
    });
    const olderYes = page
      .getByRole("radiogroup", { name: "Older permission" })
      .getByRole("radio", { name: "Yes" });
    await expect.element(olderYes).toHaveFocus();
    await vi.waitFor(() => {
      const control = olderYes.element().getBoundingClientRect();
      expect(control.top).toBeGreaterThanOrEqual(scrollNode().getBoundingClientRect().top);
      expect(control.bottom).toBeLessThanOrEqual(
        page.getByRole("textbox", { name: "Message" }).element().getBoundingClientRect().top,
      );
    });
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(chat.responded).toEqual([
        { requestId: "newer-request", value: true },
        { requestId: "older-request", value: true },
      ]),
    );
    chat.script.push({
      type: "event",
      sequence: 2,
      event: { type: "item", item: { ...older, status: "answered", answer: true } },
    });
    await expect.element(page.getByRole("textbox", { name: "Message" })).toHaveFocus();
  },
);

test("expanding a fold near the end does not drag the tail back into view", async () => {
  const items: ChatItem[] = Array.from({ length: 40 }, (_, index) => ({
    kind: "assistant-message" as const,
    id: `fold-${index}`,
    streaming: false,
    text: `Answer ${index}.`,
  }));
  items.push(
    {
      kind: "tool-call",
      id: "fold-tool-1",
      name: "read",
      arguments: '{"path":"src/a.ts"}',
      status: "done",
      output: "a",
      diff: null,
    },
    {
      kind: "tool-call",
      id: "fold-tool-2",
      name: "read",
      arguments: '{"path":"src/b.ts"}',
      status: "done",
      output: "b",
      diff: null,
    },
    {
      kind: "assistant-message",
      id: "fold-last",
      streaming: true,
      text: "Still streaming.",
    },
  );
  const chat = await renderChat(recorded([], { state: workingChat(), items }));
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  await vi.waitFor(() => expect(atEnd(scrollNode())).toBe(true));

  // The user is reading above the end: a fold expanding under them must not re-pin the tail.
  const end = scrollNode().scrollTop;
  // 20 px is inside the library's 10 % re-pin threshold, so a layout trigger would still re-pin.
  await userEvent.wheel(page.getByTestId("chat-timeline"), { delta: { y: -20 } });
  await vi.waitFor(() => expect(scrollNode().scrollTop).toBeLessThan(end - 10));
  const before = scrollNode().scrollTop;
  const group = page.getByRole("button", { name: "Read 2 files" });
  await expect.element(group).toBeVisible();
  // A native click: `userEvent.click` scrolls the row into view first, which would move the list.
  const groupElement = group.element();
  if (!(groupElement instanceof HTMLElement)) throw new Error("the tool group is not a button");
  groupElement.click();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  // A layout change is not a data append: the tail must not re-pin over the user's position.
  expect(Math.abs(scrollNode().scrollTop - before)).toBeLessThan(2);
});

test("keyboard opening a focused fold just above the viewport keeps the reading row", async () => {
  const items: ChatItem[] = [
    ...Array.from({ length: 20 }, (_, index): ChatItem => ({
      kind: "notice",
      id: `before-${index}`,
      text: `Before ${index}`,
    })),
    { kind: "user-message", id: "above", text: "Do the work" },
    READ("above-work", "above.ts"),
    { kind: "assistant-message", id: "above-answer", text: "Done", streaming: false },
    ...Array.from({ length: 50 }, (_, index): ChatItem => ({
      kind: "notice",
      id: `after-${index}`,
      text: `After ${index}`,
    })),
  ];
  const memory = chatTranscriptStore();
  memory.remember({ key: "turn:above", index: 21 }, false);
  const chat = await renderChat(
    recorded([], { state: { ...IDLE_CHAT, turn: "settled" }, items }),
    {},
    { memory },
  );
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  const fold = page.getByRole("button", { name: "Worked" });
  await expect.element(fold).toBeVisible();
  const button = fold.element();
  if (!(button instanceof HTMLElement)) throw new Error("the fold is not a button");
  button.focus();
  await userEvent.wheel(page.getByTestId("chat-timeline"), { delta: { y: 160 } });
  await vi.waitFor(() =>
    expect(button.getBoundingClientRect().bottom).toBeLessThan(
      scrollNode().getBoundingClientRect().top,
    ),
  );
  expect(document.activeElement).toBe(button);
  const reading = topRowKey();
  await userEvent.keyboard("{Enter}");
  await expect.element(fold).toHaveAttribute("aria-expanded", "true");
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  expect(topRowKey()).toBe(reading);
});

/** A fresh transcript per test: the list's item identities must not outlive one render. */
const userAndAnswer = (): ChatItem[] => [
  { kind: "user-message", id: "u1", text: "Fix the auth test." },
  { kind: "assistant-message", id: "a1", streaming: false, text: "Done." },
];

const READ = (id: string, path: string): ChatItem => ({
  kind: "tool-call",
  id,
  name: "read",
  arguments: `{"path":"${path}"}`,
  status: "done",
  output: "contents",
  diff: null,
});

async function expectSteeredWorkVisible() {
  await expect.element(page.getByRole("button", { name: "Read old.ts" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Read current.ts" })).toBeVisible();
  expect(page.getByRole("button", { name: "Worked" }).elements()).toHaveLength(0);
}

test("steering queue changes never hide work while a turn runs, even with duplicate prompts", async () => {
  const items: ChatItem[] = [
    { kind: "user-message", id: "old", text: "same prompt" },
    READ("old-work", "old.ts"),
    { kind: "user-message", id: "current", text: "same prompt" },
    READ("current-work", "current.ts"),
  ];
  const chat = await renderChat(recorded([], { state: workingChat(), items }));
  await expect.element(page.getByRole("button", { name: "Read old.ts" })).toBeVisible();
  chat.script.push({
    type: "event",
    sequence: 1,
    event: { type: "item", item: { kind: "user-message", id: "steer", text: "same prompt" } },
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().sequence).toBe(1));
  await expectSteeredWorkVisible(); // The message arrives before the queue update.
  chat.script.push({
    type: "event",
    sequence: 2,
    event: { type: "state", state: { ...workingChat(), steering: ["same prompt"] } },
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().sequence).toBe(2));
  await expectSteeredWorkVisible();
  chat.script.push({ type: "event", sequence: 3, event: { type: "state", state: workingChat() } });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().sequence).toBe(3));
  await expectSteeredWorkVisible();
  chat.script.push({
    type: "event",
    sequence: 4,
    event: { type: "state", state: { ...IDLE_CHAT, turn: "settled" } },
  });
  await vi.waitFor(() =>
    expect(page.getByRole("button", { name: "Worked" }).elements()).toHaveLength(2),
  );
  expect(page.getByRole("button", { name: "Read current.ts" }).elements()).toHaveLength(0);
});

test("a narrating turn folds to one row, keeps its last message and expands back to its work", async () => {
  const items: ChatItem[] = [
    { kind: "user-message", id: "u1", text: "Fix the auth test." },
    { kind: "assistant-message", id: "a0", streaming: false, text: "Let me read the test first." },
    READ("t1", "src/a.ts"),
    READ("t2", "src/b.ts"),
    { kind: "assistant-message", id: "a1", streaming: false, text: "Now the module." },
    { kind: "assistant-message", id: "a2", streaming: false, text: "Fixed." },
  ];
  const chat = await renderChat(recorded([], { state: { ...IDLE_CHAT, turn: "settled" }, items }));
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));

  const fold = page.getByRole("button", { name: "Worked" });
  await expect.element(fold).toBeVisible();
  await expect.element(fold).toHaveAttribute("aria-expanded", "false");
  // T3's shape: the prompt, the fold and the turn's terminal message; the narration between them
  // is behind the fold with the work.
  await expect.element(page.getByText("Fix the auth test.")).toBeVisible();
  await expect.element(page.getByText("Fixed.")).toBeVisible();
  expect(page.getByText("Let me read the test first.").elements()).toHaveLength(0);
  expect(page.getByText("Now the module.").elements()).toHaveLength(0);
  expect(page.getByRole("button", { name: "Read 2 files" }).elements()).toHaveLength(0);

  await userEvent.click(fold);
  await expect.element(fold).toHaveAttribute("aria-expanded", "true");
  await expect.element(page.getByText("Let me read the test first.")).toBeVisible();
  await expect.element(page.getByText("Now the module.")).toBeVisible();
  const group = page.getByRole("button", { name: "Read 2 files" });
  await expect.element(group).toBeVisible();
  await userEvent.click(group);
  await expect.element(page.getByRole("button", { name: "Read src/a.ts" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Read src/b.ts" })).toBeVisible();

  // Closing the fold hides the work again without losing the group's own disclosure.
  await userEvent.click(fold);
  expect(page.getByRole("button", { name: "Read 2 files" }).elements()).toHaveLength(0);
  await userEvent.click(fold);
  await expect.element(page.getByRole("button", { name: "Read src/a.ts" })).toBeVisible();
});

test("the working row becomes the turn's fold when the turn ends", async () => {
  const items: ChatItem[] = [
    { kind: "user-message", id: "u1", text: "Fix the auth test." },
    READ("t1", "src/a.ts"),
  ];
  const chat = await renderChat(recorded([], { state: workingChat(), items }));
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));

  // While the turn runs its work is visible and the tail says what is happening.
  await expect.element(page.getByText("Working", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Read src/a.ts" })).toBeVisible();
  expect(page.getByRole("button", { name: "Worked" }).elements()).toHaveLength(0);

  chat.script.push({
    type: "event",
    sequence: 1,
    event: { type: "state", state: { ...IDLE_CHAT, turn: "settled" } },
  });

  // The turn ended: the live row is gone and the same work is behind the turn's fold.
  await expect.element(page.getByRole("button", { name: "Worked" })).toBeVisible();
  expect(page.getByText("Working", { exact: true }).elements()).toHaveLength(0);
  expect(page.getByRole("button", { name: "Read src/a.ts" }).elements()).toHaveLength(0);
});

test("a message's copy action is mounted, tabbable and revealed by hover or focus", async () => {
  const chat = await renderChat(
    recorded([], { state: { ...IDLE_CHAT, turn: "settled" }, items: userAndAnswer() }),
  );
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));

  const copies = page.getByRole("button", { name: "Copy message" });
  await vi.waitFor(() => expect(copies.elements()).toHaveLength(2));
  const userRow = copies.first().element().parentElement;
  if (userRow === null) throw new Error("the copy action has no row");
  // Mounted but quiet until the message is hovered or the keyboard reaches the action.
  expect(getComputedStyle(userRow).opacity).toBe("0");
  await expect.element(copies.first()).toHaveAttribute("tabindex", "0");

  await userEvent.hover(page.getByRole("article", { name: "Your message" }));
  await vi.waitFor(() => expect(getComputedStyle(userRow).opacity).toBe("1"));

  // Keyboard focus reveals the same row, so a hover-only action is never the only way in.
  page.getByRole("article", { name: "Agent message" }).element().focus();
  copies.last().element().focus();
  const answerRow = copies.last().element().parentElement;
  if (answerRow === null) throw new Error("the answer's copy action has no row");
  await vi.waitFor(() => expect(getComputedStyle(answerRow).opacity).toBe("1"));
  await expect.element(copies.last()).toHaveFocus();
});

test("copy writes the message's own text and answers with a check", async () => {
  const clipboard = stubClipboard(async () => undefined);
  const chat = await renderChat(
    recorded([], { state: { ...IDLE_CHAT, turn: "settled" }, items: userAndAnswer() }),
  );
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));

  const answerCopy = page.getByRole("button", { name: "Copy message" }).last();
  expect(answerCopy.element().querySelector("svg")?.getAttribute("class") ?? "").toContain(
    "lucide-copy",
  );
  await userEvent.click(answerCopy);
  await vi.waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith("Done."));
  await expect
    .poll(() => answerCopy.element().querySelector("svg")?.getAttribute("class") ?? "")
    .toContain("lucide-check");
  clipboard.restore();
});

test("a refused copy says why above the composer", async () => {
  const clipboard = stubClipboard(() =>
    Promise.reject(new Error("The system denied clipboard access.")),
  );
  const chat = await renderChat(
    recorded([], { state: { ...IDLE_CHAT, turn: "settled" }, items: userAndAnswer() }),
  );
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));

  await userEvent.click(page.getByRole("button", { name: "Copy message" }).last());
  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent("The system denied clipboard access.");
  clipboard.restore();
});

test("quoting a selection puts a blockquote at the composer's caret", async () => {
  const chat = await renderChat();
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().sequence).toBe(RECORDED_SEQUENCE));

  const article = page.getByRole("article", { name: "Agent message" }).element();
  const paragraph = article.querySelector("p");
  if (paragraph === null) throw new Error("the answer has no paragraph");
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));

  // Only a selection inside an assistant message raises the action.
  const quote = page.getByRole("button", { name: "Quote selection" });
  await expect.element(quote).toBeVisible();
  await userEvent.click(quote);

  const composer = page.getByRole("textbox", { name: "Message" });
  await expect
    .element(composer)
    .toHaveValue("> Waits on the condition instead of a fixed delay.\n\n");
  await expect.element(composer).toHaveFocus();
  // The caret is on the line below the quote, where the comment goes.
  await vi.waitFor(() => {
    const field = composer.element();
    if (!(field instanceof HTMLTextAreaElement)) throw new Error("the composer is not a textarea");
    expect(field.selectionStart).toBe(field.value.length);
  });
});

test("a selection outside an assistant message raises no quote action", async () => {
  const chat = await renderChat();
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().sequence).toBe(RECORDED_SEQUENCE));

  const range = document.createRange();
  range.selectNodeContents(page.getByRole("article", { name: "Your message" }).element());
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));

  await new Promise((resolve) => requestAnimationFrame(resolve));
  expect(page.getByRole("button", { name: "Quote selection" }).elements()).toHaveLength(0);
});

test("a session's own memory opens its folds", async () => {
  // The workspace keeps one memory per session; a tab switch mounts the pane again with it.
  const memory = chatTranscriptStore();
  memory.toggle("group:t1");
  const chat = await renderChat(RECORDED_CHAT, {}, { memory });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));

  await expect.element(page.getByRole("button", { name: "Changed 1 file" })).toBeVisible();
});

test("another session's memory leaves the same transcript closed", async () => {
  const chat = await renderChat(RECORDED_CHAT, {}, { memory: chatTranscriptStore() });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));

  await expect.element(page.getByRole("button", { name: /^Ran 1 command/ })).toBeVisible();
  expect(page.getByRole("button", { name: "Changed 1 file" }).elements()).toHaveLength(0);
});

test("a session's memory reopens the transcript on the row it was reading", async () => {
  // A tab switch unmounts the pane; the workspace hands the new mount the row it was left on.
  const memory = chatTranscriptStore();
  memory.remember({ key: "long-100", index: 100 }, false);
  const chat = await renderChat(longChat(160), {}, { memory });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));

  await vi.waitFor(() => expect(topRowKey()).toBe("long-100"));
  // It is neither the tail nor the start: the end follow was not re-armed by the mount.
  expect(atEnd(scrollNode())).toBe(false);
  expect(scrollNode().scrollTop).toBeGreaterThan(0);
});

test("coming back to a session that was at the end resumes the end follow", async () => {
  // A session left at the end remembers that, not only its row: the next item must still arrive
  // at the bottom instead of leaving the view 81 px short of it.
  const memory = chatTranscriptStore();
  memory.remember({ key: "turn:long-100", index: 20 }, true);
  const chat = await renderChat(longChat(160), {}, { memory });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  await vi.waitFor(() => expect(atEnd(scrollNode())).toBe(true));

  chat.script.push({
    type: "event",
    sequence: 1,
    event: { type: "item", item: { kind: "notice", id: "n-return", text: "After the return." } },
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().sequence).toBe(1));
  await vi.waitFor(() => expect(atEnd(scrollNode())).toBe(true));
});

test("a remembered row that no longer exists reopens near where it was", async () => {
  const snapshot = longChat(160)[0];
  if (snapshot?.type !== "snapshot") throw new Error("longChat does not start with a snapshot");
  const rows = chatRows({
    items: snapshot.snapshot.items,
    turn: "working",
    waiting: false,
  });
  const expected = rows[30]?.key;
  expect(expected).toBeDefined();

  const memory = chatTranscriptStore();
  // The row is gone — its fold was closed again — so the row at the same index stands in for it.
  memory.remember({ key: "turn:gone", index: 30 }, false);
  const chat = await renderChat(longChat(160), {}, { memory });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));

  await vi.waitFor(() => expect(topRowKey()).toBe(expected));
  expect(scrollNode().scrollTop).toBeGreaterThan(0);
  expect(atEnd(scrollNode())).toBe(false);
});

test("a streaming reasoning row is not live while the agent waits on the user", async () => {
  const items: ChatItem[] = [
    { kind: "user-message", id: "u-wait", text: "Fix the auth test." },
    { kind: "reasoning", id: "r-wait", text: "The race is the timeout.", streaming: true },
    {
      kind: "user-request",
      id: "q-wait",
      request: "confirm",
      title: "Run the suite?",
      body: null,
      options: [],
      placeholder: null,
      prefill: null,
      expiresAt: null,
      status: "pending",
    },
  ];
  const chat = await renderChat(recorded([], { state: workingChat(), items }));
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));

  // The stream is open, but nothing is being thought: the row is `Thought`, and quiet.
  const log = page.getByRole("log", { name: "Chat transcript" });
  const row = log.getByRole("button", { name: "Thought" });
  await expect.element(row).toBeVisible();
  expect(log.getByRole("button", { name: "Thinking" }).elements()).toHaveLength(0);
  const label = row.element().querySelector("span:last-of-type");
  expect(label === null ? "" : getComputedStyle(label).animationName).toBe("none");
});

test("closing the tab and coming back keeps this session's scroll position", async () => {
  const memory = chatTranscriptStore();
  const first = await renderChat(longChat(160), {}, { memory });
  await vi.waitFor(() => expect(first.script.store.getSnapshot().loaded).toBe(true));

  // Read somewhere above the end.
  await userEvent.wheel(page.getByTestId("chat-timeline"), { delta: { y: -1200 } });
  await vi.waitFor(() => expect(atEnd(scrollNode())).toBe(false));
  const reading = topRowKey();
  expect(reading).toBeDefined();
  expect(scrollNode().scrollTop).toBeGreaterThan(0);
  await first.unmount();

  // The pane mounts again on the way back to this tab, with this session's memory: the same row is
  // under the top edge, and the end follow was not re-armed by the mount.
  const second = await renderChat(longChat(160), {}, { memory });
  await vi.waitFor(() => expect(topRowKey()).toBe(reading));
  expect(atEnd(scrollNode())).toBe(false);
  await second.unmount();
});

test("the live rows shimmer only when motion is allowed", async () => {
  await emulateMotion("reduce");
  // The live rows are rendered on their own: the shimmer is the kit's media query, and the list
  // that mounts them is the other tests' subject.
  await render(
    <div className="h-screen w-full">
      <TranscriptRow
        row={{ kind: "working", key: "working" }}
        expanded={new Set()}
        onToggleFold={() => {}}
        onRespond={async () => {}}
        onAnswered={() => {}}
        onFailure={() => {}}
        waiting={false}
      />
      <TranscriptRow
        row={{
          kind: "item",
          key: "r-shimmer",
          item: { kind: "reasoning", id: "r-shimmer", text: "The race.", streaming: true },
        }}
        expanded={new Set()}
        onToggleFold={() => {}}
        onRespond={async () => {}}
        onAnswered={() => {}}
        onFailure={() => {}}
        waiting={false}
      />
    </div>,
  );

  const working = page.getByText("Working", { exact: true }).element();
  const thinking = page.getByText("Thinking", { exact: true }).element();
  expect(working.parentElement!.getBoundingClientRect().height).toBeCloseTo(
    thinking.parentElement!.getBoundingClientRect().height,
    1,
  );
  expect(getComputedStyle(working).animationName).toBe("none");
  expect(getComputedStyle(thinking).animationName).toBe("none");

  await emulateMotion("no-preference");
  await vi.waitFor(() => expect(getComputedStyle(working).animationName).toBe("tw-shimmer"));
  expect(getComputedStyle(thinking).animationName).toBe("tw-shimmer");
});

test("opening a turn fold at the end keeps the row that was clicked where it is", async () => {
  // A long turn, then a finished turn whose fold sits at the tail: the shape a settled transcript
  // ends in. The fold must not re-pin the end under the pointer that opened it.
  const items: ChatItem[] = [{ kind: "user-message", id: "u1", text: "Tell me about the build." }];
  for (let index = 0; index < 40; index += 1) {
    items.push({
      kind: "assistant-message",
      id: `tail-${index}`,
      streaming: false,
      text: `Answer ${index}. The quick brown fox jumps over the lazy dog, twice.`,
    });
  }
  items.push(
    { kind: "user-message", id: "u2", text: "Fix the auth test." },
    READ("t1", "src/a.ts"),
    READ("t2", "src/b.ts"),
    { kind: "assistant-message", id: "a1", streaming: false, text: "Done." },
  );
  const chat = await renderChat(recorded([], { state: { ...IDLE_CHAT, turn: "settled" }, items }));
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  await vi.waitFor(() => expect(atEnd(scrollNode())).toBe(true));
  // The list measures its first window before it is stable; a disclosure before that lands on
  // estimates. Wait for the frame the rows are measured in.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const fold = page.getByRole("button", { name: "Worked" }).element();
  if (!(fold instanceof HTMLElement)) throw new Error("the fold is not a button");
  const before = fold.getBoundingClientRect().top;
  // A native click: `userEvent.click` scrolls the row into view first, which would move the list.
  fold.click();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const after = page.getByRole("button", { name: "Worked" }).element().getBoundingClientRect().top;
  expect(Math.abs(after - before)).toBeLessThan(2);
});

test("an activity row carries a 16 px glyph and a 12 px disclosure", async () => {
  const chat = await renderChat();
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));

  // The group's own row: the action glyph in T3's 24 px slot, then the one disclosure chevron.
  const group = page.getByRole("button", { name: /^Ran 1 command/ }).element();
  const glyphs = [...group.querySelectorAll("svg")].map((svg) => svg.getBoundingClientRect().width);
  expect(glyphs[0]).toBe(16);
  expect(glyphs[1]).toBe(12);
});

test("the transcript scrolls from the keyboard and the end follow is released and re-taken", async () => {
  const chat = await renderChat(longChat(160));
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  await vi.waitFor(() => expect(atEnd(scrollNode())).toBe(true));

  const log = page.getByRole("log", { name: "Chat transcript" });
  log.element().focus();
  await expect.element(log).toHaveFocus();

  const before = scrollNode().scrollTop;
  await userEvent.keyboard("{PageUp}");
  await vi.waitFor(() => expect(scrollNode().scrollTop).toBeLessThan(before - 100));
  const afterPageUp = scrollNode().scrollTop;

  // An appended row must not drag the view back while the user is reading above the end.
  chat.script.push({
    type: "event",
    sequence: 1,
    event: { type: "item", item: { kind: "notice", id: "n-key", text: "Typed while reading." } },
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().sequence).toBe(1));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  expect(scrollNode().scrollTop).toBeLessThan(afterPageUp + 2);
  expect(atEnd(scrollNode())).toBe(false);

  // End takes the follow again, and the next row does arrive at the bottom.
  await userEvent.keyboard("{End}");
  await vi.waitFor(() => expect(atEnd(scrollNode())).toBe(true));
  chat.script.push({
    type: "event",
    sequence: 2,
    event: {
      type: "item",
      item: { kind: "user-message", id: "u-key", text: "Back at the end." },
    },
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().sequence).toBe(2));
  await vi.waitFor(() => expect(atEnd(scrollNode())).toBe(true));

  // At the end, ArrowUp is the handler's 48 px step (a native arrow scroll is a different
  // amount), and the row appended after it must stay offscreen because the handler released.
  const atEndTop = scrollNode().scrollTop;
  await userEvent.keyboard("{ArrowUp}");
  await vi.waitFor(() => {
    const top = scrollNode().scrollTop;
    expect(atEndTop - top).toBeGreaterThanOrEqual(47);
    expect(atEndTop - top).toBeLessThanOrEqual(49);
  });
  chat.script.push({
    type: "event",
    sequence: 3,
    event: { type: "item", item: { kind: "notice", id: "n-arrow", text: "Above the tail." } },
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().sequence).toBe(3));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  expect(atEnd(scrollNode())).toBe(false);

  // Home and the arrow keys move without a pointer.
  await userEvent.keyboard("{Home}");
  await vi.waitFor(() => expect(scrollNode().scrollTop).toBe(0));
  await userEvent.keyboard("{ArrowDown}");
  await vi.waitFor(() => expect(scrollNode().scrollTop).toBeGreaterThan(20));
});

test("a modified Home moves only through the keyboard handler and releases the follow", async () => {
  const chat = await renderChat(longChat(160));
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  await vi.waitFor(() => expect(atEnd(scrollNode())).toBe(true));
  const log = page.getByRole("log", { name: "Chat transcript" });
  log.element().focus();
  await expect.element(log).toHaveFocus();

  // Ctrl+Home has no native list scroll; the handler's Home branch is what moves it and releases.
  await userEvent.keyboard("{Control>}{Home}{/Control}");
  await vi.waitFor(() => expect(scrollNode().scrollTop).toBe(0));
  chat.script.push({
    type: "event",
    sequence: 1,
    event: { type: "item", item: { kind: "notice", id: "n-home", text: "After Home." } },
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().sequence).toBe(1));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  expect(atEnd(scrollNode())).toBe(false);
});

test("a wheel back to the bottom re-arms the follow after a keyboard release", async () => {
  const chat = await renderChat(longChat(160));
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  await vi.waitFor(() => expect(atEnd(scrollNode())).toBe(true));
  const log = page.getByRole("log", { name: "Chat transcript" });
  log.element().focus();
  await expect.element(log).toHaveFocus();

  const before = scrollNode().scrollTop;
  await userEvent.keyboard("{PageUp}");
  await vi.waitFor(() => expect(scrollNode().scrollTop).toBeLessThan(before - 100));

  // The wheel returns to the bottom without End; that must re-arm the latch.
  await userEvent.wheel(log, { delta: { y: 2000 }, times: 10 });
  await vi.waitFor(() => expect(atEnd(scrollNode())).toBe(true));

  chat.script.push({
    type: "event",
    sequence: 1,
    event: { type: "item", item: { kind: "notice", id: "n-wheel", text: "After the wheel." } },
  });
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().sequence).toBe(1));
  await vi.waitFor(() => expect(atEnd(scrollNode())).toBe(true));
});

test("a composition-confirming Enter never sends; the next real Enter sends once", async () => {
  const chat = await renderChat(recorded([], { state: IDLE_CHAT }));
  await vi.waitFor(() => expect(chat.script.store.getSnapshot().loaded).toBe(true));
  const composer = page.getByRole("textbox", { name: "Message" });
  composer.element().focus();
  await userEvent.keyboard("hello");
  const field = composer.element();
  if (!(field instanceof HTMLTextAreaElement)) throw new Error("the composer is not a textarea");

  const keydown = (isComposing: boolean) =>
    field.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        isComposing,
        bubbles: true,
        cancelable: true,
      }),
    );

  // Chrome/Firefox order: the confirming keydown comes inside the composition.
  field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  keydown(true);
  field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(chat.sent).toHaveLength(0);
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(chat.sent).toEqual([{ text: "hello", mode: "prompt" }]));

  // Safari order: the composition ends first, so the next Enter is the confirming one.
  await userEvent.keyboard("world");
  field.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  field.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  keydown(false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(chat.sent).toHaveLength(1);
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() => expect(chat.sent[1]).toEqual({ text: "world", mode: "prompt" }));
});

for (const size of [500, 2000, 5000]) {
  test(
    `a ${size}-item transcript stays virtualized and a streamed delta stays responsive`,
    { timeout: 60_000 },
    async () => {
      const { mounted, p95 } = await measureTranscriptPerf(size);
      expect(mounted).toBeLessThan(100);
      expect(p95).toBeLessThan(100);
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
  const memory = chatTranscriptStore();
  await render(
    <div className="h-screen w-full">
      <ChatView
        store={store}
        agent="pi"
        followUp={true}
        files={NO_FILES}
        abortHint={ABORT_HINT}
        memory={memory}
        onSend={async () => {}}
        onAbort={async () => {}}
        onRespond={async () => {}}
        onChangeModel={() => {}}
        onChangeReasoning={() => {}}
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

test("the composer row shows the driver's model and reasoning and opens their choosers", async () => {
  const state = workingChat({
    model: { provider: "stub", id: "stub-1", name: "Stub One" },
    models: [
      { provider: "stub", id: "stub-1", name: "Stub One" },
      { provider: "stub", id: "stub-2", name: "Stub Two" },
    ],
    reasoning: "medium",
    reasoningLevels: ["off", "low", "medium", "high"],
  });
  const { openModel, openReasoning } = await renderChat(recorded([], { state }));

  const model = page.getByRole("button", { name: "Model Stub One" });
  const reasoning = page.getByRole("button", { name: "Reasoning medium" });
  await expect.element(model).toBeEnabled();
  await expect.element(reasoning).toBeEnabled();

  await userEvent.click(model);
  await userEvent.click(reasoning);
  expect(openModel).toHaveBeenCalledTimes(1);
  expect(openReasoning).toHaveBeenCalledTimes(1);
});

test("without a driver list the model control is disabled and Thinking still opens its picker", async () => {
  const chat = await renderChat(recorded([], { state: IDLE_CHAT }));

  await expect.element(page.getByRole("button", { name: "Model none" })).toBeDisabled();
  const thinking = page.getByRole("button", { name: "Thinking" });
  await expect.element(thinking).toBeEnabled();
  await expect.element(thinking).toHaveTextContent("Thinking");
  await userEvent.click(thinking);
  expect(chat.openReasoning).toHaveBeenCalledTimes(1);
  expect(chat.openModel).not.toHaveBeenCalled();
});
