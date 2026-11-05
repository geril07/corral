#!/usr/bin/env node
// UI kit guard for apps/web: class strings must name the scales `docs/ui-kit.md` **Spine** declares,
// inside `common/ui` and out. Layer boundaries and raw DOM controls are lint rules; this covers
// class strings, which Oxlint has no configurable rule for. The rules live in web-ui-classes.mjs.
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
    else if (/\.(?:ts|tsx)$/.test(entry)) found.push(full);
  }
  return found;
}

const problems = [];
for (const file of filesIn(root)) {
  const relative = path.relative(repository, file);
  // The kit's literals are legitimate geometry, so it answers the type/surface/focus/motion rules
  // only; a module answers every rule (`ui-kit.md`, **Spine** — ownership).
  const location = file.startsWith(`${kit}${path.sep}`) ? "kit" : "module";
  const source = readFileSync(file, "utf8");
  for (const { line, message } of classViolations(source, file, location)) {
    problems.push(`${relative}:${line}: ${message}`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(`\n${problems.length} UI kit violation(s).`);
  process.exit(1);
}
