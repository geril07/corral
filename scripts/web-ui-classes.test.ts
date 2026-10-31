import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { classViolations } from "./web-ui-classes.mjs";

const repository = path.join(import.meta.dirname, "..");
const script = path.join(import.meta.dirname, "check-web-ui.mjs");

function messages(source: string, filename = "sample.tsx") {
  return classViolations(source, filename).map(({ line, message }) => `${line}:${message}`);
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
    expect(reported).toHaveLength(7);
    expect(reported.filter((line) => line.startsWith("1:"))).toEqual([
      "1:arbitrary value in class name: bg-[#fff]",
      "1:raw colour in class name: bg-[#fff]",
    ]);
    expect(reported).toContain("2:arbitrary value in class name: p-[3px]");
    expect(reported).toContain("3:arbitrary value in class name: text-[hsl(0_0%_0%)]");
    expect(reported).toContain("3:raw colour in class name: text-[hsl(0_0%_0%)]");
    expect(reported).toContain("4:arbitrary value in class name: hover:bg-[#fff]");
    expect(reported).toContain("4:raw colour in class name: hover:bg-[#fff]");
  });

  it("accepts semantic tokens and standard layout utilities", () => {
    const source =
      'const cls = "flex items-center gap-2 p-4 text-text-muted border-border rounded-md hover:bg-surface-active md:grid-cols-2 w-full truncate";';
    expect(classViolations(source, "sample.tsx")).toEqual([]);
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

describe("guard CLI", () => {
  it("ignores a comment with an apostrophe and checks real classes", () => {
    const root = fixture({
      "apps/web/src/modules/tasks/import-card.tsx": [
        "/** The form's Create action keeps [draft] state. */",
        'export const className = "flex p-4 text-text-muted";',
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

  it("exempts common/ui", () => {
    const root = fixture({
      "apps/web/src/common/ui/panel.tsx": 'export const panel = "bg-red-500";\n',
    });
    const result = guard(root);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
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
