import { relative } from "node:path";
import { BaseSequencer, type TestSpecification } from "vite-plus/test/node";
import shardWeights from "./shard-weights.json" with { type: "json" };

const weights: Readonly<Record<string, number>> = shardWeights;
const knownSeconds = Object.values(weights)
  .filter((seconds) => Number.isFinite(seconds) && seconds > 0)
  .toSorted((a, b) => a - b);
// A new test file gets the median of the recorded durations until it is measured.
const fallbackSeconds = knownSeconds[Math.floor(knownSeconds.length / 2)] ?? 1;

/**
 * Balances whole browser-test files across Vitest's native shard processes.
 *
 * The native sequencer splits by file count; these files differ by orders of magnitude. Assign
 * longest-first to the currently lightest shard, the same load-balancing rule the old wrapper
 * used, while letting Vitest own process launch, output and exit status.
 */
export class WeightedShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]) {
    if (!this.ctx.config.browser.enabled) return super.shard(files);
    const { index, count } = this.ctx.config.shard ?? { index: 1, count: 1 };
    const weighted = files
      .map((spec) => {
        const key = relative(this.ctx.config.root, spec.moduleId).replaceAll("\\", "/");
        return { spec, key, seconds: weights[key] ?? fallbackSeconds };
      })
      .toSorted((a, b) => b.seconds - a.seconds || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const loads = Array.from({ length: count }, () => 0);
    const picked: TestSpecification[] = [];
    for (const { spec, seconds } of weighted) {
      let lightest = 0;
      for (let candidate = 1; candidate < count; candidate += 1) {
        if ((loads[candidate] ?? 0) < (loads[lightest] ?? 0)) lightest = candidate;
      }
      loads[lightest] = (loads[lightest] ?? 0) + seconds;
      if (lightest === index - 1) picked.push(spec);
    }
    return picked;
  }
}
