#!/usr/bin/env node
// Runs the browser suite as parallel `vp test` processes, splitting the test files by measured
// cost. Each Vitest process runs its own globalSetup, so every shard gets its own real server,
// config dir and git repos; inside a shard the files still share that one server and run one at a
// time (`fileParallelism: false` in apps/web/vite.config.ts).
//
// `--shard=i/N` would be simpler, but Vitest shards by *file count*: the slowest file here costs
// 13 s and the cheapest 4 ms, so count-based shards finish 5× apart and the slowest one sets the
// wall clock. Instead every discovered test file is placed on the currently least-loaded shard in
// descending weight order (longest processing time first), which keeps the shards within a couple
// of seconds of each other.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repository = resolve(import.meta.dirname, "..");
const web = join(repository, "apps", "web");
const TEST_SUFFIX = ".browser.test.tsx";
const DEFAULT_SHARDS = 4;

// Seconds each test file took in one sequential run of the suite (whole file, from the JSON
// reporter's `endTime - startTime`). Regenerate when the suite has changed a lot:
//   pnpm exec vp test run --project browser --reporter=json --outputFile=/tmp/per-file.json
// and replace the table with `name`/`endTime - startTime` pairs. Rounding to 0.1 s is enough: the
// placement only needs relative cost. Missing files are ignored; a file that is not in the table
// (new test) is charged the suite mean and goes to the least-loaded shard.
const FILE_SECONDS = {
  "src/app/bootstrap.browser.test.tsx": 0.3,
  "src/app/router.browser.test.tsx": 0.05,
  "src/common/ui/diff-view.browser.test.tsx": 0.1,
  "src/modules/board/board.browser.test.tsx": 1.1,
  "src/modules/chat/chat-view.browser.test.tsx": 4.5,
  "src/modules/keymap/keymap.browser.test.tsx": 6.1,
  "src/modules/projects/add-project-dialog.browser.test.tsx": 0.4,
  "src/modules/sessions/agent-picker.browser.test.tsx": 2.6,
  "src/modules/sessions/launch-profiles.browser.test.tsx": 8,
  "src/modules/sessions/remove-session-dialog.browser.test.tsx": 0.4,
  "src/modules/sessions/sessions.browser.test.tsx": 10.7,
  "src/modules/sessions/stopped-session.browser.test.tsx": 0.1,
  "src/modules/settings/settings.browser.test.tsx": 3,
  "src/modules/status/status.browser.test.tsx": 3.8,
  "src/modules/tasks/issue-import.browser.test.tsx": 5.5,
  "src/modules/tasks/new-task-flow.browser.test.tsx": 9.4,
  "src/modules/tasks/new-task-view.browser.test.tsx": 4.7,
  "src/modules/tasks/remove-task-dialog.browser.test.tsx": 0.5,
  "src/modules/tasks/tasks.browser.test.tsx": 12.4,
  "src/modules/terminal/terminal-view.browser.test.tsx": 0.7,
  "src/modules/workspace/chat-tab.browser.test.tsx": 1.7,
  "src/modules/workspace/find-task-dialog.browser.test.tsx": 4.4,
  "src/modules/workspace/rename-dialog.browser.test.tsx": 0.3,
  "src/modules/workspace/rename.browser.test.tsx": 5.5,
  "src/modules/workspace/selection-reload.browser.test.tsx": 2.2,
  "src/modules/workspace/session-tabs.browser.test.tsx": 1.7,
  "src/modules/workspace/sidebar-mode.browser.test.tsx": 3.2,
  "src/modules/workspace/sidebar.browser.test.tsx": 2.4,
  "src/modules/workspace/workspace-screen.browser.test.tsx": 13.1,
};
const DEFAULT_SECONDS = 3.7;

const requested = process.env.CORRAL_BROWSER_SHARDS ?? String(DEFAULT_SHARDS);
const count = Number(requested);
if (!Number.isInteger(count) || count < 1) {
  console.error(`CORRAL_BROWSER_SHARDS must be a positive integer, got "${requested}".`);
  process.exit(2);
}

/** Every browser test file as its path relative to the project root. */
function testFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...testFiles(full));
    else if (entry.name.endsWith(TEST_SUFFIX)) found.push(relative(web, full));
  }
  return found;
}

const files = testFiles(join(web, "src"));
if (files.length === 0) {
  console.error(`no *${TEST_SUFFIX} files under ${join(web, "src")}`);
  process.exit(2);
}
if (count > files.length) {
  console.error(`${count} shards for ${files.length} test files; use at most one shard per file.`);
  process.exit(2);
}

function distribute(shards) {
  const placements = Array.from({ length: shards }, () => ({ files: [], seconds: 0 }));
  // Longest first, so the tail of small files only fills gaps between shards.
  const weighed = files
    .map((path) => ({ path, seconds: FILE_SECONDS[path] ?? DEFAULT_SECONDS }))
    .toSorted((a, b) => b.seconds - a.seconds || a.path.localeCompare(b.path));
  for (const file of weighed) {
    // Ties go to the earliest shard, so the placement is deterministic.
    let cheapest = placements[0];
    for (const placement of placements) {
      if (placement.seconds < cheapest.seconds) cheapest = placement;
    }
    cheapest.files.push(file.path);
    cheapest.seconds += file.seconds;
  }
  return placements;
}

// FORCE_COLOR would interleave escape sequences into the numbers the summary parser reads.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[\\d+(?:;\\d+)*m`, "g");

function countsFrom(text) {
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0, total: 0 };
  for (const [, number, kind] of text.matchAll(/(\d+) (passed|failed|skipped|todo)/g)) {
    counts[kind] += Number(number);
  }
  const total = /\((\d+)\)$/.exec(text);
  counts.total =
    total === null
      ? counts.passed + counts.failed + counts.skipped + counts.todo
      : Number(total[1]);
  return counts;
}

/** The final `Test Files` and `Tests` lines of one shard's output, if it printed them. */
function summaryOf(output) {
  const summary = { files: null, tests: null };
  const lines = output.replace(ANSI, "").split(/\r?\n/);
  // Backwards: the reporter's summary is the last thing a shard prints, so its `Tests` line is the
  // first one found and a test that happened to print a similar line cannot be mistaken for it.
  for (let index = lines.length - 1; index >= 0 && summary.files === null; index -= 1) {
    const match = /^\s*(Test Files|Tests)\s+(\S.*?)\s*$/.exec(lines[index]);
    if (match === null) continue;
    if (match[1] === "Tests" && summary.tests === null) summary.tests = countsFrom(match[2]);
    else if (match[1] === "Test Files" && summary.tests !== null) {
      summary.files = countsFrom(match[2]);
    }
  }
  return summary;
}

function describe(counts) {
  if (counts === null) return "no summary";
  const parts = [];
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.passed > 0) parts.push(`${counts.passed} passed`);
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  if (counts.todo > 0) parts.push(`${counts.todo} todo`);
  return `${parts.join(", ")} (${counts.total})`;
}

function runShard(index, placement) {
  const started = Date.now();
  const args = ["test", "run", "--project", "browser", ...placement.files];
  return new Promise((finish) => {
    // Output is buffered per shard, so nothing prints mid-line and a failure can replay it whole.
    const child = spawn("vp", args, {
      cwd: repository,
      stdio: ["ignore", "pipe", "pipe"],
      // A .cmd shim on Windows cannot be spawned without a shell.
      shell: process.platform === "win32",
    });
    const chunks = [];
    let settled = false;
    const settle = (code, signal) => {
      if (settled) return;
      settled = true;
      finish({
        index,
        code,
        signal,
        seconds: (Date.now() - started) / 1000,
        planned: placement.seconds,
        assigned: placement.files,
        output: Buffer.concat(chunks).toString("utf8"),
      });
    };
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("error", (error) => {
      chunks.push(Buffer.from(`could not start vp: ${error.message}\n`));
      settle(1, null);
    });
    // `close`, not `exit`: it fires after both pipes are drained.
    child.on("close", settle);
  });
}

const started = Date.now();
const placements = distribute(count);
console.log(`browser suite: ${files.length} files in ${count} shard${count === 1 ? "" : "s"}`);
const shards = await Promise.all(
  placements.map((placement, offset) => runShard(offset + 1, placement)),
).then((results) => results.map((result) => ({ ...result, ...summaryOf(result.output) })));

// A shard that exits 0 without a summary is as untrustworthy as a failing one: the counts would
// silently stop adding up.
const broken = shards.filter(
  (shard) =>
    shard.code !== 0 || shard.tests === null || shard.files === null || shard.tests.failed > 0,
);

for (const shard of shards) {
  const state = broken.includes(shard)
    ? `FAILED (${shard.code === 0 ? "no summary" : `exit ${shard.code ?? shard.signal}`})`
    : "passed";
  const filesTested = shard.files === null ? "?" : shard.files.total;
  console.log(
    `shard ${shard.index}/${count}: ${state} — ${filesTested} files, ${describe(shard.tests)}, ${shard.seconds.toFixed(1)}s`,
  );
}

const total = shards.reduce(
  (sum, shard) => {
    for (const field of ["passed", "failed", "skipped", "todo", "total"]) {
      sum[field] += shard.tests?.[field] ?? 0;
    }
    sum.files += shard.files?.total ?? 0;
    return sum;
  },
  { files: 0, passed: 0, failed: 0, skipped: 0, todo: 0, total: 0 },
);

if (broken.length === 0) {
  console.log(
    `browser suite: ${total.files} files, ${describe(total)} tests in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  process.exit(0);
}

for (const shard of shards) {
  console.log(
    `\n--- shard ${shard.index}/${count} output: ${shard.assigned.length} files, ${shard.planned.toFixed(1)}s planned ---`,
  );
  for (const file of shard.assigned) console.log(`    ${file}`);
  console.log(shard.output.trimEnd());
}
console.log(
  `\nbrowser suite: FAILED — ${broken.length}/${count} shards, ${total.files} files, ${describe(total)} tests`,
);
// The worst shard's exit code, so a caller sees a failure even when one shard crashed differently.
process.exit(Math.max(1, ...shards.map((shard) => shard.code ?? 1)));
