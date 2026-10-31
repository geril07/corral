// UI kit class rules: which literal strings in apps/web are class names, and which of those
// leave common/ui. Parsing is by Oxc's public parser so comments, JSX prose and regular
// expressions are never mistaken for literals; see scripts/check-web-ui.mjs for the file walk.
import { parseSync } from "oxc-parser";

const PALETTE =
  /(?:^|[\s:])!?(?:bg|text|border|ring|outline|fill|stroke|from|via|to|shadow|decoration|accent|caret|divide|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d{1,3})?(?:\/\d{1,3})?!?(?=$|\s)/;
const CLASS_LIKE =
  /(?:^|[\s:])(?:flex|grid|block|inline|hidden|absolute|relative|fixed|sticky|w-|h-|min-|max-|p-|px-|py-|m-|mx-|my-|gap-|items-|justify-|text-|bg-|border|rounded|font-|leading-|tracking-|overflow-|truncate|whitespace-|cursor-|select-|shadow|ring-|outline-|opacity-|transition|duration-|ease-|z-|top-|left-|right-|bottom-|inset-|col-|row-|self-|place-|content-|list-|object-|align-|order-|basis-|grow|shrink|space-|divide-|fill-|stroke-|from-|via-|to-)/;
const ARBITRARY = /\[[^\]]+\]/;
const OBSOLETE_TOKEN =
  /(?:^|[\s:])(?:bg-surface(?:-raised|-active)?|text-text(?:-muted)?|(?:bg|text|border)-danger(?:-strong|-foreground)?|(?:bg|text|border)-accent-strong|outline-focus-ring|rounded-(?:control|panel))(?=\/|\s|$)/;
const RAW_COLOUR = /\b(?:rgb|hsl)a?\(|#[0-9a-fA-F]{3,8}\b/;

/** Maps a source offset to a 1-based line, counting every JavaScript line terminator. */
function lineAt(source) {
  const starts = [0];
  for (const match of source.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) {
    starts.push(match.index + match[0].length);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (starts[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

function collectCodeLiterals(node, found) {
  if (node === null || typeof node !== "object") return;
  if (node.type === "Literal" && typeof node.value === "string") {
    found.push({ value: node.value, start: node.start });
  } else if (node.type === "TemplateElement") {
    const value = node.value.cooked ?? node.value.raw;
    found.push({ value, start: node.start });
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    if (Array.isArray(child)) {
      for (const item of child) collectCodeLiterals(item, found);
    } else {
      collectCodeLiterals(child, found);
    }
  }
}

/**
 * Diagnostics for one parsed file: `{ line, message }`. A file the parser rejects yields only
 * parse errors, so malformed source fails the gate instead of being silently skipped.
 */
export function classViolations(source, filename) {
  const parsed = parseSync(filename, source);
  const line = lineAt(source);
  const diagnostics = [];

  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) {
      const offset = error.labels?.[0]?.start ?? 0;
      diagnostics.push({ line: line(offset), message: `cannot parse: ${error.message}` });
    }
    return diagnostics;
  }

  const literals = [];
  collectCodeLiterals(parsed.program, literals);
  for (const literal of literals) {
    const { value } = literal;
    const classLike = CLASS_LIKE.test(value);
    if (classLike) {
      for (const [rule, label] of [
        [ARBITRARY, "arbitrary value"],
        [RAW_COLOUR, "raw colour"],
        [OBSOLETE_TOKEN, "obsolete theme token"],
      ]) {
        const match = rule.exec(value);
        if (match === null) continue;
        const token = classTokenAt(value, match.index);
        diagnostics.push({
          line: line(literal.start + token.start),
          message: `${label} in class name: ${token.value}`,
        });
      }
    }
    // Palette utilities are matched on their own: a variant prefix such as `hover:` is not a
    // word boundary, and `bg-red-500` carries a numeric shade.
    const palette = PALETTE.exec(value);
    if (palette !== null) {
      const token = classTokenAt(value, palette.index + leadingSpace(palette));
      diagnostics.push({
        line: line(literal.start + token.start),
        message: `palette colour in class name: ${token.value}`,
      });
    }
  }
  return diagnostics;
}

/** Length of the whitespace the regex consumed between the token and its predecessor. */
function leadingSpace(match) {
  return match[0].length - match[0].trimStart().length;
}

/** The whitespace-delimited class token containing `offset`, with any variant prefix. */
function classTokenAt(value, offset) {
  let start = offset;
  while (start > 0 && !/\s/.test(value[start - 1])) start -= 1;
  let end = offset;
  while (end < value.length && !/\s/.test(value[end])) end += 1;
  return { start, value: value.slice(start, end) };
}
