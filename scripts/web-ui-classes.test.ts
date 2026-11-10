import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { classViolations } from "./web-ui-classes.mjs";

const repository = path.join(import.meta.dirname, "..");
const script = path.join(import.meta.dirname, "check-web-ui.mjs");

function messages(source: string, filename = "sample.tsx", location: "module" | "kit" = "module") {
  return classViolations(source, filename, location).map(
    ({ line, message }) => `${line}:${message}`,
  );
}

const temporaryRoots: string[] = [];

function fixture(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "corral-ui-guard-"));
  temporaryRoots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

function guard(root: string) {
  return spawnSync(process.execPath, [script, root], { encoding: "utf8" });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("class literals", () => {
  it("ignores comments, JSX prose and regular expressions", () => {
    const source = [
      "/** The form's Create action: bg-red-500 [draft]. */",
      "// Don't write hover:text-blue-600 here.",
      'const [value, setValue] = useState("");',
      'const panel = <div className="p-4">Don\'t use bg-red-500 in prose.</div>;',
      "const pattern = /bg-red-500|text-blue-600/g;",
    ].join("\n");
    expect(classViolations(source, "panel.tsx")).toEqual([]);
  });

  it("reads quotes nested in strings and templates", () => {
    const source = [
      "const label = 'Don\\'t';",
      'const quoted = "a \'p-4\' and \\"flex\\"";',
      "const template = `grid ${gap} gap-2`;",
      'const injected = `p-4 ${active ? "text-blue-600" : ""}`;',
    ].join("\n");
    expect(messages(source)).toEqual(["4:palette colour in class name: text-blue-600"]);
  });

  it("reports palette colours with shades, variants and important", () => {
    const source = [
      'const a = "bg-red-500";',
      'const b = "hover:text-blue-600";',
      'const c = "md:!bg-red-500/50";',
      'const d = "dark:border-gray-700";',
      'const e = "group-hover:from-red-500";',
      'const f = "text-white";',
      'const g = "bg-black/50";',
      'const h = "bg-red";',
    ].join("\n");
    expect(classViolations(source, "sample.tsx").map(({ line }) => line)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8,
    ]);
    expect(messages(source).every((line) => line.includes("palette colour"))).toBe(true);
  });

  it("still reports arbitrary values and raw colours", () => {
    const source = [
      'const a = "bg-[#fff]";',
      'const b = "p-[3px]";',
      'const c = "text-[hsl(0_0%_0%)]";',
      'const d = "hover:bg-[#fff]";',
    ].join("\n");
    const reported = messages(source);
    expect(reported).toHaveLength(9);
    expect(reported.filter((line) => line.startsWith("1:"))).toEqual([
      "1:arbitrary value in class name: bg-[#fff]",
      "1:raw colour in class name: bg-[#fff]",
    ]);
    expect(reported).toContain("2:arbitrary value in class name: p-[3px]");
    expect(reported).toContain("2:spacing outside the scale in class name: p-[3px]");
    expect(reported).toContain("3:arbitrary value in class name: text-[hsl(0_0%_0%)]");
    expect(reported).toContain("3:raw colour in class name: text-[hsl(0_0%_0%)]");
    expect(reported).toContain("3:type outside the ramp in class name: text-[hsl(0_0%_0%)]");
    expect(reported).toContain("4:arbitrary value in class name: hover:bg-[#fff]");
    expect(reported).toContain("4:raw colour in class name: hover:bg-[#fff]");
  });

  it("accepts semantic tokens and standard layout utilities", () => {
    const source =
      'const cls = "flex items-center gap-2 p-4 text-muted-foreground border-border rounded-md hover:bg-accent md:grid-cols-2 w-full truncate";';
    expect(classViolations(source, "sample.tsx")).toEqual([]);
  });

  it("rejects retired kit tokens instead of silently rendering unstyled controls", () => {
    for (const token of [
      "bg-surface",
      "hover:bg-surface-active",
      "text-text-muted",
      "bg-danger-strong",
      "rounded-control",
      "rounded-(--control-radius)",
      "text-status-blocked",
      "bg-status-done",
      "focus-visible:outline-focus-ring",
    ]) {
      expect(messages(`const cls = "${token}";`)).toEqual([
        `1:obsolete theme token in class name: ${token}`,
      ]);
    }
  });

  it("reports malformed source at its position instead of skipping the file", () => {
    const source = ['const fine = "p-4";', "const broken = ;"].join("\n");
    const [diagnostic] = classViolations(source, "broken.tsx");
    expect(diagnostic?.line).toBe(2);
    expect(diagnostic?.message).toContain("cannot parse");
  });

  it("keeps line positions through Unicode text and multi-line templates", () => {
    // Astral characters take two UTF-16 code units: a byte-offset diagnostic would drift.
    const unicode = [
      `// ${"🌍".repeat(100)} naïve — Обзор задачи 🐎`,
      'const title = "Grüße 🌍";',
      'const className = "p-4";',
      'const danger = "bg-red-500";',
      "// trailing line keeps a drifted offset visible",
    ].join("\n");
    expect(classViolations(unicode, "unicode.tsx")).toEqual([
      { line: 4, message: "palette colour in class name: bg-red-500" },
    ]);

    const template = ["const cls = `p-4", "  ${gap}", "  hover:text-blue-600`;"].join("\n");
    expect(messages(template)).toEqual(["3:palette colour in class name: hover:text-blue-600"]);

    // U+2028 is a JavaScript line terminator, so positions after it follow the parser's lines.
    const separator = 'const text = "a\u2028b"; const danger = "bg-red-500";';
    expect(messages(separator)).toEqual(["2:palette colour in class name: bg-red-500"]);
  });

  it("checks class strings in JSX attributes", () => {
    const source = 'const panel = <div className="flex bg-red-500" />;';
    expect(messages(source)).toEqual(["1:palette colour in class name: bg-red-500"]);
  });
});

describe("kit control appearance", () => {
  it("rejects literal and computed class overrides, including aliased and namespace imports", () => {
    for (const source of [
      'import { Button } from "../common/ui/index.ts"; const view = <Button className="rounded-none" />;',
      'import { Input as Editor } from "../common/ui/input.tsx"; const view = <Editor className={classes} />;',
      'import * as UI from "@/common/ui"; const view = <UI.RadioGroup className="flex" />;',
      'import { Button } from "../common/ui/index.ts"; const Action = Button; const view = <Action className="w-full" />;',
      'import * as UI from "@/common/ui"; const Action = UI.Button; const view = <Action className="w-full" />;',
      'import * as UI from "@/common/ui"; const { Button } = UI; const view = <Button className="h-7 px-1" />;',
      'import * as UI from "@/common/ui"; const { Button: Action } = UI; const view = <Action className="h-7" />;',
    ]) {
      expect(messages(source)).toEqual([
        "1:visual override on UI kit control: className; use a kit variant",
      ]);
    }
  });

  it("rejects controls composed without JSX", () => {
    for (const source of [
      'import { createElement } from "react"; import { Button } from "../common/ui/index.ts"; const view = createElement(Button, { className: "h-7 px-1" });',
      'import * as React from "react"; import * as UI from "../common/ui/index.ts"; const view = React.createElement(UI.Button, { style: { width: 8 } });',
      'import { cloneElement } from "react"; const view = cloneElement(child, { className: classes });',
      'import { Button } from "../common/ui/index.ts"; const Action = Button; const view = createElement(Action, { ...props });',
    ]) {
      expect(messages(source)).toHaveLength(1);
      expect(messages(source)[0]).toMatch(
        /^1:(?:visual override|opaque prop spread) on UI kit control/,
      );
    }

    // A DOM element factory and a control spread through a non-JSX call stay untouched.
    for (const source of [
      'const canvas = document.createElement("canvas");',
      'import { createElement } from "react"; const view = createElement("div", { className: "p-4" });',
      'import { fork } from "./fork.ts"; const view = fork(Button, { className: classes });',
    ]) {
      expect(messages(source)).toEqual([]);
    }
  });

  it("covers the stock wrappers and compositions, not just buttons", () => {
    for (const name of [
      "IconButton",
      "FormField",
      "FieldLegend",
      "FieldSet",
      "RadioChoice",
      "Badge",
      "Alert",
      "Item",
      "TextLink",
      "CommandItem",
      "ComboboxInput",
      "TaskDialog",
      "TaskCommandDialog",
      "Hint",
      "Kbd",
      "DropdownMenuItem",
    ]) {
      const source = `import { ${name} } from "../common/ui/index.ts"; const view = <${name} className={classes} />;`;
      expect(messages(source)).toEqual([
        "1:visual override on UI kit control: className; use a kit variant",
      ]);
    }
  });

  it("rejects styling and opaque composition/prop escape hatches", () => {
    for (const attribute of [
      "style={{ opacity: 0.5 }}",
      'width="100"',
      'height="20"',
      'color="primary"',
      "render={<span />}",
      "{...props}",
    ]) {
      const reported = messages(
        `import { Button } from "../common/ui/index.ts"; const view = <Button ${attribute} />;`,
      );
      expect(reported).toHaveLength(1);
      expect(reported[0]).toMatch(/UI kit control/);
    }
  });

  it("allows stock variants, behavior props, structural layout and ordinary content typography", () => {
    const source =
      'import { Button, AppShell, MeasuredBox } from "../common/ui/index.ts"; const view = <AppShell className="h-screen"><MeasuredBox className="overflow-y-auto" maxHeight={100}><div className="flex gap-4"><Button variant="secondary" layout="tree" size="sm" onClick={run} disabled={busy} aria-label="Run"><span className="truncate text-muted-foreground">Run</span></Button></div></MeasuredBox></AppShell>;';
    expect(messages(source)).toEqual([]);
  });
});

describe("spine scales", () => {
  it("rejects every banned form inside the kit, not only in modules", () => {
    for (const [source, expected] of [
      ["ring-ring/50", "focus ring outside the recipe in class name: ring-ring/50"],
      ["focus-visible:ring-3", "focus ring outside the recipe in class name: focus-visible:ring-3"],
      ["ring-3", "focus ring outside the recipe in class name: ring-3"],
      ["ring-[3px]", "focus ring outside the recipe in class name: ring-[3px]"],
      [
        "ring-1 ring-foreground/10",
        "focus ring outside the recipe in class name: ring-foreground/10",
      ],
      [
        "ring-foreground/10 ring-1",
        "focus ring outside the recipe in class name: ring-foreground/10",
      ],
      [
        "ring-1 dark:ring-foreground/10",
        "focus ring outside the recipe in class name: dark:ring-foreground/10",
      ],
      [
        "focus-visible:ring-destructive/20",
        "focus ring outside the recipe in class name: focus-visible:ring-destructive/20",
      ],
      [
        "dark:focus-visible:ring-destructive/40",
        "focus ring outside the recipe in class name: dark:focus-visible:ring-destructive/40",
      ],
      ["focus-within:ring-2", "focus ring outside the recipe in class name: focus-within:ring-2"],
      ["text-lg", "type outside the ramp in class name: text-lg"],
      ["text-[13px]", "type outside the ramp in class name: text-[13px]"],
      ["font-bold", "type outside the ramp in class name: font-bold"],
      ["font-[600]", "type outside the ramp in class name: font-[600]"],
      ["tracking-tight", "type outside the ramp in class name: tracking-tight"],
      ["tracking-wide", "type outside the ramp in class name: tracking-wide"],
      ["shadow-md", "surface outside the tiers in class name: shadow-md"],
      ["rounded-2xl", "surface outside the tiers in class name: rounded-2xl"],
      ["backdrop-blur-sm", "surface outside the tiers in class name: backdrop-blur-sm"],
      ["backdrop-blur", "surface outside the tiers in class name: backdrop-blur"],
      ["transition", "motion outside the budget in class name: transition"],
      ["transition!", "motion outside the budget in class name: transition!"],
      ["transition-all", "motion outside the budget in class name: transition-all"],
      ["transition-colors", "motion outside the budget in class name: transition-colors"],
      ["ease-in", "motion outside the budget in class name: ease-in"],
      ["ease-in-out", "motion outside the budget in class name: ease-in-out"],
      ["ease-linear", "motion outside the budget in class name: ease-linear"],
      ["duration-100", "motion outside the budget in class name: duration-100"],
      ["animation-duration-100", "motion outside the budget in class name: animation-duration-100"],
      ["animate-pulse", "motion outside the budget in class name: animate-pulse"],
      ["blur-in", "motion outside the budget in class name: blur-in"],
      ["text-primary", "primary as a text colour in class name: text-primary"],
    ]) {
      expect(messages(`const cls = "${source}";`, "kit.tsx", "kit")).toContain(`1:${expected}`);
    }
  });

  it("keeps aria-invalid's width and alpha rings, and the shared focus recipe", () => {
    expect(
      messages(
        'const cls = "focus-visible:ring-2 focus-visible:ring-ring aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40";',
        "kit.tsx",
        "kit",
      ),
    ).toEqual([]);
  });

  it("bans an alpha-weakened ring in a module too", () => {
    for (const token of ["ring-ring/50", "focus-visible:ring-destructive/20"]) {
      expect(messages(`const cls = "${token}";`)).toEqual([
        `1:focus ring outside the recipe in class name: ${token}`,
      ]);
    }
  });

  it("bans bare transitions and the undeclared easings in a module too", () => {
    for (const token of ["transition", "ease-in", "ease-in-out", "ease-linear"]) {
      expect(messages(`const cls = "${token}";`)).toEqual([
        `1:motion outside the budget in class name: ${token}`,
      ]);
    }
  });

  it("allows the raw shapes the kit needs and nothing the gate owns", () => {
    for (const token of [
      // A border-compensating inset: a spacing step plus or minus the hairline.
      "p-[calc(var(--spacing)*2-1px)]",
      // A chip whose box must not multiply with the device scale.
      "h-[calc(var(--spacing)*5.25)]",
      // Popup and viewport bounds.
      "w-[36rem]",
      "min-w-[96px]",
      "max-h-[25.5rem]",
      "max-h-[calc(100dvh-2rem)]",
      // The tooltip arrow keeps its 2 px radius.
      "rounded-[2px]",
      // One ring width and offset.
      "focus-visible:ring-2",
      "ring-2",
      // Tailwind's default timing function (no class).
      "duration-200",
      "duration-200!",
      // Derived gutters: a step plus the control it clears (icon, indicator, close button).
      "pl-7",
      "pr-8",
      "pr-12",
      "pr-18",
    ]) {
      expect(messages(`const cls = "${token}";`, "kit.tsx", "kit")).toEqual([]);
    }
  });

  it("leaves the kit's palette and retired-token rules to modules", () => {
    expect(
      messages(
        'const cls = "w-[36rem] bg-red-500 rounded-control rounded-(--control-radius)";',
        "kit.tsx",
        "kit",
      ),
    ).toEqual([]);
  });

  it("keeps the control-radius token, glass, raw type and wide tracking out of modules", () => {
    for (const [token, message] of [
      [
        "rounded-(--control-radius)",
        "obsolete theme token in class name: rounded-(--control-radius)",
      ],
      ["backdrop-blur-sm", "surface outside the tiers in class name: backdrop-blur-sm"],
      ["font-[600]", "type outside the ramp in class name: font-[600]"],
      ["tracking-wide", "type outside the ramp in class name: tracking-wide"],
    ]) {
      expect(messages(`const cls = "${token}";`)).toContain(`1:${message}`);
    }
  });

  it("holds a module to the spacing steps and the kit's derived gutters to the kit", () => {
    for (const token of ["pl-7", "pr-18", "p-7", "gap-7", "px-24"]) {
      expect(messages(`const cls = "${token}";`)).toEqual([
        `1:spacing outside the scale in class name: ${token}`,
      ]);
    }
    for (const token of ["p-0", "p-2.5", "gap-6", "pl-6", "px-4", "pb-6", "p-2!", "p-2.5!"]) {
      expect(messages(`const cls = "${token}";`)).toEqual([]);
    }
  });

  it("requires entry animations to be motion-safe, while transitions keep a reduce partner", () => {
    // A reduce partner cannot beat the later data-open rule at equal specificity, so a bare entry
    // is a violation in the kit and in a module even when the partner is present.
    for (const location of ["kit", "module"] as const) {
      expect(messages('const cls = "data-open:animate-in";', "sample.tsx", location)).toEqual([
        "1:entry animation without motion-safe in class name: data-open:animate-in",
      ]);
    }
    expect(
      messages('const cls = "animate-in fade-in-0 motion-reduce:animate-none";', "kit.tsx", "kit"),
    ).toEqual(["1:entry animation without motion-safe in class name: animate-in"]);

    for (const source of [
      'const cls = "data-open:motion-safe:animate-in data-open:motion-safe:fade-in-0";',
      'const cls = "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95";',
      'const cls = "motion-safe:data-open:animate-in";',
      // Exit animations belong to the same budget: dialogs fade and scale out through motion-safe.
      'const cls = "data-closed:motion-safe:animate-out data-closed:motion-safe:fade-out-0 data-closed:motion-safe:zoom-out-95";',
      // The reduce partner itself stays legal, and a non-entry animation may keep one.
      'const cls = "motion-reduce:animate-none";',
      'const cls = "animate-wiggle motion-reduce:animate-none";',
      'const cls = "transition-transform motion-reduce:transition-none";',
    ]) {
      expect(messages(source, "kit.tsx", "kit")).toEqual([]);
    }

    // The partner cannot win against a later data-variant rule or an important animation.
    for (const source of [
      'const cls = "data-open:animate-[wiggle_1s] motion-reduce:animate-none";',
      'const cls = "animate-[wiggle_1s]! motion-reduce:animate-none";',
    ]) {
      expect(messages(source, "kit.tsx", "kit").length).toBeGreaterThan(0);
    }
  });
});

describe("guard CLI", () => {
  it("fails a module control override with its source location", () => {
    const root = fixture({
      "apps/web/src/modules/tasks/actions.tsx":
        'import { Button } from "../../common/ui/index.ts";\nexport const view = <Button className="px-2" />;',
    });
    const result = guard(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "apps/web/src/modules/tasks/actions.tsx:2: visual override on UI kit control: className",
    );
  });
  it("ignores a comment with an apostrophe and checks real classes", () => {
    const root = fixture({
      "apps/web/src/modules/tasks/import-card.tsx": [
        "/** The form's Create action keeps [draft] state. */",
        'export const className = "flex p-4 text-muted-foreground";',
        "// The user's draft stays.",
      ].join("\n"),
    });
    const result = guard(root);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");

    writeFileSync(
      path.join(root, "apps/web/src/modules/tasks/import-card.tsx"),
      [
        "/** The form's Create action keeps [draft] state. */",
        'export const className = "flex p-4 hover:bg-red-500";',
        "// The user's draft stays.",
      ].join("\n"),
    );
    const flagged = guard(root);
    expect(flagged.status).toBe(1);
    expect(flagged.stderr).toContain(
      "apps/web/src/modules/tasks/import-card.tsx:2: palette colour in class name: hover:bg-red-500",
    );
  });

  it("leaves common/ui's palette literals to the kit", () => {
    const root = fixture({
      "apps/web/src/common/ui/panel.tsx": 'export const panel = "bg-red-500";\n',
    });
    const result = guard(root);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("walks common/ui for the kit rules too", () => {
    const root = fixture({
      "apps/web/src/common/ui/panel.tsx": 'export const panel = "flex text-lg";\n',
    });
    const result = guard(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "apps/web/src/common/ui/panel.tsx:1: type outside the ramp in class name: text-lg",
    );
  });

  it("fails malformed files with their position", () => {
    const root = fixture({
      "apps/web/src/modules/tasks/broken.tsx": 'export const panel = "p-4";\nconst value = ;\n',
    });
    const result = guard(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("apps/web/src/modules/tasks/broken.tsx:2: cannot parse");
  });

  it("passes on the checked-in web source", () => {
    const result = guard(repository);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
