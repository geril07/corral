import { expect, test } from "vite-plus/test";
import { measureTranscriptPerf } from "../../../test/chat-transcript-perf.tsx";

/**
 * The 10,000-item measurement runs alone in its own single-process suite: shard load makes the
 * p95 budget unrepresentative, while the assertion and its budget stay unchanged. Run it with
 * `pnpm test:perf`; the normal `pnpm test:browser` gate excludes `*.perf.browser.test.tsx`.
 */
test(
  "a 10000-item transcript stays virtualized and a streamed delta stays responsive",
  { timeout: 120_000 },
  async () => {
    const { mounted, p95 } = await measureTranscriptPerf(10_000);
    expect(mounted).toBeLessThan(100);
    expect(p95).toBeLessThan(100);
  },
);
