// UI kit class rules: which literal strings in apps/web are class names, and which of those leave
// the scales `docs/ui-kit.md` **Spine** declares. Parsing is by Oxc's public parser so comments,
// JSX prose and regular expressions are never mistaken for literals; see
// scripts/check-web-ui.mjs for the file walk.
import { parseSync } from "oxc-parser";

const PALETTE =
  /(?:^|[\s:])!?(?:bg|text|border|ring|outline|fill|stroke|from|via|to|shadow|decoration|accent|caret|divide|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)(?:-\d{1,3})?(?:\/\d{1,3})?!?(?=$|\s)/;
const CLASS_LIKE =
  /(?:^|[\s:])(?:flex|grid|block|inline|hidden|absolute|relative|fixed|sticky|w-|h-|min-|max-|p-|px-|py-|pt-|pb-|pl-|pr-|m-|mx-|my-|gap-|items-|justify-|text-|bg-|border|rounded|font-|leading-|tracking-|overflow-|truncate|whitespace-|cursor-|select-|shadow|ring-|outline-|opacity-|transition|duration-|ease-|animate-|animation-|fade-|zoom-|blur-|backdrop-|z-|top-|left-|right-|bottom-|inset-|col-|row-|self-|place-|content-|list-|object-|align-|order-|basis-|grow|shrink|space-|divide-|fill-|stroke-|from-|via-|to-)/;
const ARBITRARY = /\[[^\]]+\]/;
const OBSOLETE_TOKEN =
  /(?:^|[\s:])(?:bg-surface(?:-raised|-active)?|text-text(?:-muted)?|(?:bg|text|border)-danger(?:-strong|-foreground)?|(?:bg|text|border)-accent-strong|(?:bg|text)-status-[a-z]+|outline-focus-ring|rounded-(?:control|panel|\(--control-radius\)))(?=\/|\s|$)/;
const RAW_COLOUR = /\b(?:rgb|hsl)a?\(|#[0-9a-fA-F]{3,8}\b/;
/** Tailwind's spacing unit is the rhythm; a module names one of these steps, never a value. */
const SPACING_STEPS = "0|0\\.5|1|1\\.5|2|2\\.5|3|4|5|6";
const SPACING = new RegExp(
  `(?:^|[\\s:])(?:p|px|py|pt|pb|pl|pr|gap|gap-x|gap-y)-(?!(?:${SPACING_STEPS})!?(?=$|[\\s]))[^\\s]+`,
);
const TYPE =
  /(?:^|[\s:])text-(?:lg|xl|[2-9]xl)(?=$|[\s])|(?:^|[\s:])text-\[|(?:^|[\s:])font-(?:bold|extrabold|black)(?=$|[\s])|(?:^|[\s:])font-\[|(?:^|[\s:])tracking-(?:tighter|tight|wide)(?=$|[\s])/;
const SURFACE =
  /(?:^|[\s:])(?:shadow-(?:2xs|xs|sm|md|lg|xl|2xl)|rounded-(?:2xl|3xl|4xl))(?=$|[\s])|(?:^|[\s:])rounded-\[(?!2px\])|(?:^|[\s:])backdrop-blur(?:-|(?=$|[\s]))/;
const FOCUS =
  /(?:^|[\s:])(?<!aria-invalid:)(?:ring-[a-z][a-z0-9-]*\/\d{1,3}|ring-3!?(?=$|[\s])|ring-\[3px\]!?(?=$|[\s])|focus-within:ring-)/;
const MOTION =
  /(?:^|[\s:])(?:transition!?(?=$|[\s])|transition-(?:all|colors|\[)|ease-(?:in|in-out|linear)!?(?=$|[\s])|animate-(?:ping|pulse|spin|bounce)(?=$|[\s])|blur-(?:in|out)(?=$|[\s-])|(?:animation-)?duration-(?!200!?(?=$|[\s])))/;
/** Transitions pair with a reduce override; enter and exit animations instead sit behind `motion-safe`. */
const MOTION_USE = /(?:^|[\s:])transition-/;
const MOTION_REDUCE = /motion-reduce:/;
const MOTION_SAFE = /(?:^|:)motion-safe:(?:[^\s:]+:)*animate-/;
const MOTION_ENTRY = /(?:^|:)animate-in(?=$|[\s!])/;
const ANIMATE_REDUCE = /(?:^|[\s:])motion-reduce:animate-none(?=$|[\s])/;
const PRIMARY_TEXT = /(?:^|[\s:])text-primary(?![\w-])/;

/**
 * The class-string rules. `scope: "module"` binds only files outside `common/ui`; `scope: "all"`
 * binds the kit too, because a broken recipe lives inside the kit and a module-only walk cannot see
 * it. `guard: "any"` runs the rule on every literal; the rest run only on class-like ones.
 */
export const CLASS_RULES = [
  { label: "arbitrary value", pattern: ARBITRARY, scope: "module" },
  { label: "raw colour", pattern: RAW_COLOUR, scope: "module" },
  { label: "obsolete theme token", pattern: OBSOLETE_TOKEN, scope: "module" },
  { label: "palette colour", pattern: PALETTE, scope: "module", guard: "any" },
  { label: "spacing outside the scale", pattern: SPACING, scope: "module" },
  { label: "type outside the ramp", pattern: TYPE, scope: "all" },
  { label: "surface outside the tiers", pattern: SURFACE, scope: "all" },
  { label: "focus ring outside the recipe", pattern: FOCUS, scope: "all" },
  { label: "motion outside the budget", pattern: MOTION, scope: "all" },
  { label: "primary as a text colour", pattern: PRIMARY_TEXT, scope: "all" },
];
/** Props that change how a control looks; behavior and structure travel as their own props. */
const VISUAL_PROPS = new Set(["className", "style", "color", "width", "height", "render"]);

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
 * Diagnostics for one parsed file: `{ line, message }`. `location` is `"module"` for a file
 * outside `common/ui` and `"kit"` for one inside it; the kit answers only the rules whose scope is
 * `"all"`. A file the parser rejects yields only parse errors, so malformed source fails the gate
 * instead of being silently skipped.
 */
export function classViolations(source, filename, location = "module") {
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

  controlOverrides(parsed.program, diagnostics, line);
  const literals = [];
  collectCodeLiterals(parsed.program, literals);
  for (const literal of literals) {
    const { value } = literal;
    const classLike = CLASS_LIKE.test(value);
    for (const rule of CLASS_RULES) {
      if (rule.scope === "module" && location === "kit") continue;
      if (rule.guard !== "any" && !classLike) continue;
      const match = rule.pattern.exec(value);
      if (match === null) continue;
      const token = classTokenAt(value, match.index + leadingSpace(match));
      // Invalid-state rings keep their width and alpha: they are a validation signal, not focus.
      if (rule.label === "focus ring outside the recipe" && token.value.includes("aria-invalid"))
        continue;
      diagnostics.push({
        line: line(literal.start + token.start),
        message: `${rule.label} in class name: ${token.value}`,
      });
    }
    // Per-element reduced motion (`ui-kit.md`, **Spine** — no global kill switch). A transition
    // keeps its own reduce override. An entry animation is conditional on motion being allowed:
    // a bare `animate-in` loses to its `data-open:` rule even when a reduce partner exists, so
    // only `motion-safe` may carry it. A non-entry animation may still pair with `animate-none`.
    if (classLike && MOTION_USE.test(value) && !MOTION_REDUCE.test(value)) {
      const match = MOTION_USE.exec(value);
      const token = classTokenAt(value, match.index + leadingSpace(match));
      diagnostics.push({
        line: line(literal.start + token.start),
        message: `motion without a reduced-motion pair in class name: ${token.value}`,
      });
    }
    if (classLike) {
      for (const match of value.matchAll(/\S+/g)) {
        const token = match[0];
        if (!/(?:^|:)animate-/.test(token) || MOTION_SAFE.test(token)) continue;
        const entry = MOTION_ENTRY.test(token);
        // A reduce partner cannot beat a `data-*`/`aria-*` rule emitted later, and `!` beats
        // everything, so the escape hatch is only sound for an unforced, variant-free animation.
        const variantDependent = /(?:^|:)(?:data|aria)-/.test(token);
        const forced = token.endsWith("!");
        if (!entry && !variantDependent && !forced && ANIMATE_REDUCE.test(value)) continue;
        diagnostics.push({
          line: line(literal.start + match.index),
          message: entry
            ? `entry animation without motion-safe in class name: ${token}`
            : `motion without a reduced-motion pair in class name: ${token}`,
        });
      }
    }
  }
  return diagnostics;
}

/** Control appearance belongs to the kit, including when an import is aliased or namespaced. */
function controlOverrides(program, diagnostics, line) {
  const structural = new Set([
    "AppShell",
    "ContentLane",
    "MainPanel",
    "MeasuredBox",
    "SidebarPanel",
    "TreeIndent",
    "TreeRow",
    "VisualResizeHandle",
    "VisualSidebar",
    "VisualCompanion",
    "VisualSplitHandle",
    "VisualTabPanel",
    "VisualTabStrip",
  ]);
  const controls = new Set();
  const namespaces = new Set();
  for (const node of program.body) {
    if (
      node.type !== "ImportDeclaration" ||
      !/(?:common\/ui(?:\/|$)|@\/components\/ui\/)/.test(node.source.value)
    )
      continue;
    for (const specifier of node.specifiers) {
      if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(specifier.local.name);
      else {
        const name = specifier.imported?.name ?? specifier.local.name;
        if (/^[A-Z]/.test(name) && !structural.has(name)) controls.add(specifier.local.name);
      }
    }
  }
  /** A control reached through its imported name or a namespace member. */
  function controlReference(expression) {
    if (expression?.type === "Identifier") return controls.has(expression.name);
    return (
      expression?.type === "MemberExpression" &&
      expression.object.type === "Identifier" &&
      namespaces.has(expression.object.name) &&
      expression.property.type === "Identifier" &&
      !structural.has(expression.property.name)
    );
  }

  function propDiagnostic(start, spread, prop) {
    if (!spread && !VISUAL_PROPS.has(prop)) return;
    diagnostics.push({
      line: line(start),
      message: spread
        ? "opaque prop spread on UI kit control: pass behavior props explicitly; appearance belongs in kit variants"
        : `visual override on UI kit control: ${prop}; use a kit variant`,
    });
  }

  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "VariableDeclarator") {
      const init = node.init;
      if (init?.type === "Identifier" && controls.has(init.name)) controls.add(node.id.name);
      if (
        init?.type === "Identifier" &&
        namespaces.has(init.name) &&
        node.id.type === "ObjectPattern"
      ) {
        for (const property of node.id.properties) {
          if (property.type !== "Property" || property.computed) continue;
          const imported =
            property.key.type === "Identifier" ? property.key.name : property.key.value;
          if (typeof imported !== "string" || !/^[A-Z]/.test(imported)) continue;
          if (!structural.has(imported) && property.value.type === "Identifier")
            controls.add(property.value.name);
        }
      }
      if (
        init?.type === "MemberExpression" &&
        namespaces.has(init.object.name) &&
        !structural.has(init.property.name)
      )
        controls.add(node.id.name);
    }
    if (node.type === "JSXOpeningElement") {
      const name = node.name;
      const control =
        name.type === "JSXIdentifier"
          ? controls.has(name.name)
          : name.type === "JSXMemberExpression" &&
            namespaces.has(name.object.name) &&
            !structural.has(name.property.name);
      if (control) {
        for (const attribute of node.attributes) {
          propDiagnostic(
            attribute.start,
            attribute.type === "JSXSpreadAttribute",
            attribute.name?.name,
          );
        }
      }
    }
    // `createElement(Control, { className })` and `cloneElement(element, { className })` skin a
    // control without JSX. cloneElement's element cannot be resolved statically, so a visual prop
    // object on it counts as a control override.
    if (node.type === "CallExpression") {
      const callee = node.callee;
      const called =
        callee.type === "Identifier"
          ? callee.name
          : callee.type === "MemberExpression" && callee.property.type === "Identifier"
            ? callee.property.name
            : undefined;
      const props = node.arguments[1];
      const targets = node.arguments[0];
      if (
        props?.type === "ObjectExpression" &&
        (called === "cloneElement" || (called === "createElement" && controlReference(targets)))
      ) {
        for (const property of props.properties) {
          if (property.type === "SpreadElement") propDiagnostic(property.start, true);
          else if (property.type === "Property" && !property.computed)
            propDiagnostic(property.start, false, property.key.name ?? property.key.value);
        }
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === "type" || key === "start" || key === "end") continue;
      if (Array.isArray(child)) for (const item of child) walk(item);
      else walk(child);
    }
  }
  walk(program);
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
