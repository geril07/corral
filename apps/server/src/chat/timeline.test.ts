import type { ChatStreamMessage } from "@corral/protocol/chat";
import { expect, test } from "vite-plus/test";
import { ChatTimeline, MAX_REPLAYED_EVENTS } from "./timeline.ts";

function notice(timeline: ChatTimeline, text: string): void {
  timeline.setState({ steering: [text] });
}

/** Pulls messages until `count` of them arrived (the watch may yield more than asked). */
async function take(
  watch: AsyncGenerator<ChatStreamMessage>,
  count: number,
): Promise<ChatStreamMessage[]> {
  const messages: ChatStreamMessage[] = [];
  while (messages.length < count) {
    // oxlint-disable-next-line no-await-in-loop -- one message per iteration is the point
    const next = await watch.next();
    if (next.done === true) throw new Error(`the watch ended after ${messages.length} messages`);
    messages.push(next.value);
  }
  return messages;
}

test("a watch starts with a snapshot, then streams every event in sequence", async () => {
  const timeline = new ChatTimeline();
  notice(timeline, "one");
  const watch = timeline.watch(undefined, undefined);
  try {
    const [first] = await take(watch, 1);
    expect(first).toMatchObject({
      type: "snapshot",
      snapshot: { sequence: 1, state: { steering: ["one"] }, items: [] },
    });
    notice(timeline, "two");
    const [next] = await take(watch, 1);
    expect(next).toEqual({
      type: "event",
      sequence: 2,
      event: { type: "state", state: expect.objectContaining({ steering: ["two"] }) },
    });
  } finally {
    await watch.return(undefined);
  }
});

test("a watch with the last sequence replays the events the client missed", async () => {
  const timeline = new ChatTimeline();
  notice(timeline, "one");
  notice(timeline, "two");
  const watch = timeline.watch(1, undefined);
  try {
    const [replayed] = await take(watch, 1);
    expect(replayed).toMatchObject({ type: "event", sequence: 2 });
    notice(timeline, "three");
    const [live] = await take(watch, 1);
    expect(live).toMatchObject({ type: "event", sequence: 3 });
  } finally {
    await watch.return(undefined);
  }
});

test("an cursor the server no longer holds gets a snapshot instead of a hole", async () => {
  const timeline = new ChatTimeline();
  for (let index = 0; index < MAX_REPLAYED_EVENTS + 5; index++) notice(timeline, `n${index}`);
  expect(timeline.eventsAfter(0)).toBeUndefined();

  const watch = timeline.watch(0, undefined);
  try {
    const [first] = await take(watch, 1);
    expect(first).toMatchObject({
      type: "snapshot",
      snapshot: { sequence: MAX_REPLAYED_EVENTS + 5 },
    });
  } finally {
    await watch.return(undefined);
  }
});

test("a cursor from the future is a hole too; the current sequence is a replay of nothing", () => {
  const timeline = new ChatTimeline();
  notice(timeline, "one");
  expect(timeline.eventsAfter(5)).toBeUndefined();
  expect(timeline.eventsAfter(-1)).toBeUndefined();
  expect(timeline.eventsAfter(1)).toEqual([]);
});

test("closing the timeline ends the watch after the events already emitted", async () => {
  const timeline = new ChatTimeline();
  const watch = timeline.watch(undefined, undefined);
  try {
    await take(watch, 1);
    notice(timeline, "last");
    timeline.close();
    expect(await watch.next()).toMatchObject({ value: { type: "event", sequence: 1 } });
    expect(await watch.next()).toEqual({ done: true, value: undefined });
  } finally {
    await watch.return(undefined);
  }
});

test("an aborted signal ends the watch", async () => {
  const timeline = new ChatTimeline();
  const controller = new AbortController();
  const watch = timeline.watch(undefined, controller.signal);
  await take(watch, 1);
  controller.abort();
  expect(await watch.next()).toEqual({ done: true, value: undefined });
});

test("a replacement keeps its place and the snapshot stays authoritative", () => {
  const timeline = new ChatTimeline();
  timeline.put({ kind: "assistant-message", id: "a", text: "one", streaming: true });
  timeline.put({ kind: "user-message", id: "u", text: "after" });
  timeline.appendText("a", " two");
  timeline.put({ kind: "assistant-message", id: "a", text: "one two", streaming: false });
  expect(timeline.snapshot().items).toEqual([
    { kind: "assistant-message", id: "a", text: "one two", streaming: false },
    { kind: "user-message", id: "u", text: "after" },
  ]);
});
