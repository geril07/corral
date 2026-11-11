#!/usr/bin/env node
// UI kit guard for apps/web: class strings must name the scales `docs/ui-kit.md` **Spine** declares,
// inside `common/ui` and out. Layer boundaries and raw DOM controls are lint rules; this covers
// class strings, which Oxlint has no configurable rule for, and module stylesheets, which may not
// select on the kit's `data-slot` marker. The class rules live in web-ui-classes.mjs.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { classViolations } from "./web-ui-classes.mjs";

// An explicit repository root lets tests run the real CLI over a temporary tree.
const repository = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, ".."));
const root = path.join(repository, "apps", "web", "src");
const kit = path.join(root, "common", "ui");
const SKIP = new Set(["routeTree.gen.ts"]);

function filesIn(directory) {
  const found = [];
  for (const entry of readdirSync(directory).toSorted()) {
    if (SKIP.has(entry)) continue;
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) found.push(...filesIn(full));
    else if (/\.(?:ts|tsx|css)$/.test(entry)) found.push(full);
  }
  return found;
}

/**
 * A module stylesheet may not reach a kit control through the `data-slot` marker the kit sets. Every
 * attribute form names a slot — `[data-slot="button"]`, `[data-slot=button]`, `[data-slot^="dialog"]`
 * — so the selector itself is the violation, whatever value it names (`ui-kit.md`, **Spine** —
 * ownership). The kit's own stylesheet is where those selectors belong.
 */
const KIT_SLOT_SELECTOR = /\[data-slot[^\]]*\]/g;

const problems = [];
for (const file of filesIn(root)) {
  const relative = path.relative(repository, file);
  // The kit's literals are legitimate geometry, so it answers the type/surface/focus/motion rules
  // only; a module answers every rule (`ui-kit.md`, **Spine** — ownership).
  const location = file.startsWith(`${kit}${path.sep}`) ? "kit" : "module";
  const source = readFileSync(file, "utf8");
  if (file.endsWith(".css")) {
    if (location === "kit") continue;
    for (const match of source.matchAll(KIT_SLOT_SELECTOR)) {
      const line = source.slice(0, match.index).split("\n").length;
      problems.push(
        `${relative}:${line}: module stylesheet selects on the kit's data-slot: ${match[0]}`,
      );
    }
    continue;
  }
  for (const { line, message } of classViolations(source, file, location)) {
    problems.push(`${relative}:${line}: ${message}`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(`\n${problems.length} UI kit violation(s).`);
  process.exit(1);
}
