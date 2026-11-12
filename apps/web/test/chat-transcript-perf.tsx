import { expect, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { ChatViewHarness as ChatView } from "./chat-view-harness.tsx";
import { longChat, scriptedChat } from "./recorded-chat.ts";

/** These measurements never resolve or open files; the lane's own file covers links. */
const NO_FILES = {
  resolve: async () => [],
  read: async () => {
    throw new Error("no file reads in the perf fixture");
  },
  open: async () => undefined,
};

/**
 * One transcript size, measured the same way in the normal gate and in the isolated perf run.
 * The list opens at the end, so the streaming answer is mounted before it is measured; each
 * sample is the time one delta took to reach the screen.
 */
export async function measureTranscriptPerf(
  size: number,
): Promise<{ p95: number; max: number; mounted: number }> {
  const script = scriptedChat(longChat(size));
  const screen = await render(
    <div className="h-screen w-full">
      <ChatView
        store={script.store}
        agent="pi"
        followUp
        files={NO_FILES}
        abortHint="alt+a ."
        onSend={async () => undefined}
        onAbort={async () => undefined}
        onRespond={async () => undefined}
        onChangeModel={() => undefined}
        onChangeReasoning={() => undefined}
      />
    </div>,
  );
  try {
    await vi.waitFor(() => expect(script.store.getSnapshot().loaded).toBe(true));
    const itemId = `long-${size - 1}`;
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(`Short answer ${size - 1}.`),
    );

    const samples: number[] = [];
    let sequence = 0;
    for (let index = 0; index < 20; index += 1) {
      // One update at a time: the sample is the time this delta took to reach the screen.
      sequence += 1;
      const start = performance.now();
      script.push({
        type: "event",
        sequence,
        event: { type: "delta", itemId, text: " more" },
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- one measured update at a time
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      samples.push(performance.now() - start);
    }
    samples.sort((left, right) => left - right);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1] ?? 0;
    const max = samples[samples.length - 1] ?? 0;
    const mounted = document.querySelectorAll('article[aria-label="Agent message"]').length;
    // The measured numbers belong in the slice report; a log line keeps them in the gate log.
    console.log(JSON.stringify({ size, p95, max, mounted }));
    return { p95, max, mounted };
  } finally {
    script.close();
    await screen.unmount();
  }
}
