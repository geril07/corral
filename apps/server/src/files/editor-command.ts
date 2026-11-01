/**
 * The editor a local file link opens, decided once here so the config parser and the launch agree:
 * `[editor] command`, else `$VISUAL`, else `$EDITOR` (the order X11 and most CLIs use), and each
 * parsed as a command line. `{file}`, `{line}` and `{column}` are filled in; a command without a
 * placeholder gets the path appended, which is what `$EDITOR=nvim` relies on.
 */

export type CommandSplit = { readonly argv: string[] } | { readonly problem: string };

/** Splits a command line the way a POSIX shell would for quoting and backslashes, without expanding anything. */
export function splitCommand(text: string): CommandSplit {
  const argv: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote === undefined && (char === " " || char === "\t" || char === "\n")) {
      if (started) {
        argv.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    started = true;
    if (quote === undefined && (char === "'" || char === '"')) {
      quote = char;
      continue;
    }
    if (quote === char) {
      quote = undefined;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      const next = text[index + 1];
      if (next === undefined) return { problem: "the command ends with a backslash" };
      current += next;
      index += 1;
      continue;
    }
    current += char;
  }
  if (quote !== undefined) {
    return {
      problem: `the command has an unterminated ${quote === '"' ? "double" : "single"} quote`,
    };
  }
  if (started) argv.push(current);
  if (argv.length === 0) return { problem: "the command is empty" };
  return { argv };
}

export const EDITOR_PLACEHOLDERS = ["file", "line", "column"] as const;

const PLACEHOLDER = /\{([^{}]*)\}/g;
const HAS_PLACEHOLDER = /\{[^{}]*\}/;

/** A placeholder this build does not fill, e.g. `{lineno}`; the entry is dropped rather than run wrong. */
export function placeholderProblem(argv: readonly string[]): string | undefined {
  for (const token of argv) {
    for (const match of token.matchAll(PLACEHOLDER)) {
      const name = match[1] ?? "";
      if (!(EDITOR_PLACEHOLDERS as readonly string[]).includes(name)) {
        return `unknown placeholder {${name}}; use {file}, {line} or {column}`;
      }
    }
  }
  return undefined;
}

/** The command the file link runs, with the target filled in. */
export function fillEditorArgv(
  argv: readonly string[],
  target: { file: string; line?: number | undefined; column?: number | undefined },
): string[] {
  const values: Readonly<Record<string, string>> = {
    file: target.file,
    line: String(target.line ?? 1),
    column: String(target.column ?? 1),
  };
  if (!argv.some((token) => HAS_PLACEHOLDER.test(token))) return [...argv, target.file];
  return argv.map((token) =>
    token.replace(PLACEHOLDER, (whole: string, name: string) => values[name] ?? whole),
  );
}

/** One configured editor, in precedence order, with the layer it came from for the refusal text. */
export interface EditorSource {
  /** Where it came from: a config key or an environment variable. */
  readonly label: string;
  readonly text: string;
}

/**
 * The editors the server would try, `[editor] command` first, then `$VISUAL`, then `$EDITOR`. Empty
 * values are skipped, so setting `VISUAL=` to opt out falls through to `$EDITOR` as X11 expects.
 */
export function editorSources(
  configured: string,
  env: Readonly<Record<string, string | undefined>>,
): EditorSource[] {
  const sources: EditorSource[] = [];
  if (configured.trim() !== "") sources.push({ label: "[editor] command", text: configured });
  const visual = env["VISUAL"] ?? "";
  if (visual.trim() !== "") sources.push({ label: "$VISUAL", text: visual });
  const editor = env["EDITOR"] ?? "";
  if (editor.trim() !== "") sources.push({ label: "$EDITOR", text: editor });
  return sources;
}

export type EditorCommand = { readonly command: string; readonly args: string[] };

/**
 * The argv to launch, `undefined` when nothing is configured, or a problem naming the layer whose
 * command line could not be parsed. The first source that parses wins: a broken `$VISUAL` does not
 * shadow a usable `$EDITOR` any more than an empty one does.
 */
export function resolveEditorCommand(
  sources: readonly EditorSource[],
  target: { file: string; line?: number | undefined; column?: number | undefined },
): EditorCommand | { readonly problem: string } | undefined {
  const problems: string[] = [];
  for (const source of sources) {
    const split = splitCommand(source.text);
    if ("problem" in split) {
      problems.push(`${source.label}: ${split.problem}`);
      continue;
    }
    const placeholders = placeholderProblem(split.argv);
    if (placeholders !== undefined) {
      problems.push(`${source.label}: ${placeholders}`);
      continue;
    }
    const argv = fillEditorArgv(split.argv, target);
    return { command: argv[0]!, args: argv.slice(1) };
  }
  if (problems.length > 0) return { problem: problems.join("; ") };
  return undefined;
}

/** What a refusal says when nothing could be run. */
export function editorUnsetReason(
  sources: readonly EditorSource[],
  resolved: { readonly problem: string } | undefined,
): string {
  if (resolved !== undefined) return `No usable editor: ${resolved.problem}.`;
  if (sources.length === 0) {
    return "No editor is configured: set [editor] command in config.toml, or $VISUAL or $EDITOR on the server.";
  }
  return "No usable editor is configured for local file links.";
}
