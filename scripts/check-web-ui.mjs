#!/usr/bin/env node
// UI kit guard for apps/web: no arbitrary values or raw palette colours in class names outside
// common/ui. Layer boundaries and raw DOM controls are lint rules; this covers class strings,
// which Oxlint has no configurable rule for.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..", "apps", "web", "src");
const kit = path.join(root, "common", "ui");
const SKIP = new Set(["routeTree.gen.ts"]);

const PALETTE =
  /(?:^|\s)(?:bg|text|border|ring|outline|fill|stroke|from|via|to|shadow|decoration|accent|caret|divide|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:\s|$|\/)/;
const CLASS_LIKE =
  /(?:^|\s)(?:flex|grid|block|inline|hidden|absolute|relative|fixed|sticky|w-|h-|min-|max-|p-|px-|py-|m-|mx-|my-|gap-|items-|justify-|text-|bg-|border|rounded|font-|leading-|tracking-|overflow-|truncate|whitespace-|cursor-|select-|shadow|ring-|outline-|opacity-|transition|duration-|ease-|z-|top-|left-|right-|bottom-|inset-|col-|row-|self-|place-|content-|list-|object-|align-|order-|basis-|grow|shrink|space-|divide-|fill-|stroke-|from-|via-|to-)/;
const ARBITRARY = /\[[^\]]+\]/;
const RAW_COLOUR = /\b(?:rgb|hsl)a?\(|#[0-9a-fA-F]{3,8}\b/;

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

function stringLiterals(source) {
  const literals = [];
  for (const match of source.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/gs)) {
    const value = match[2] ?? "";
    const start = match.index ?? 0;
    literals.push({ value, line: source.slice(0, start).split("\n").length });
  }
  return literals;
}

const problems = [];
for (const file of filesIn(root)) {
  if (file.startsWith(`${kit}${path.sep}`)) continue;
  const relative = path.relative(path.join(root, "..", "..", ".."), file);
  const source = readFileSync(file, "utf8");
  for (const { value, line } of stringLiterals(source)) {
    if (!CLASS_LIKE.test(value)) continue;
    if (ARBITRARY.test(value))
      problems.push(`${relative}:${line}: arbitrary value in class name: ${value}`);
    if (RAW_COLOUR.test(value))
      problems.push(`${relative}:${line}: raw colour in class name: ${value}`);
    else if (PALETTE.test(value))
      problems.push(`${relative}:${line}: palette colour in class name: ${value}`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(`\n${problems.length} UI kit violation(s) outside common/ui.`);
  process.exit(1);
}
