import { expect, test } from "vite-plus/test";
import {
  editorSources,
  editorUnsetReason,
  fillEditorArgv,
  placeholderProblem,
  resolveEditorCommand,
  splitCommand,
} from "./editor-command.ts";

const argvOf = (text: string): readonly string[] => {
  const split = splitCommand(text);
  if ("problem" in split) throw new Error(split.problem);
  return split.argv;
};

test("a command line splits on quoting and backslashes without expanding anything", () => {
  expect(argvOf("code --goto")).toEqual(["code", "--goto"]);
  expect(argvOf("  nvim   -p  ")).toEqual(["nvim", "-p"]);
  expect(argvOf(`"/opt/My Editor/bin/edit" --wait`)).toEqual(["/opt/My Editor/bin/edit", "--wait"]);
  expect(argvOf(`sh -c 'echo "$HOME"'`)).toEqual(["sh", "-c", 'echo "$HOME"']);
  expect(argvOf(`a "b \\" c"`)).toEqual(["a", 'b " c']);
  expect(argvOf(`a ""`)).toEqual(["a", ""]);
  expect(argvOf(`echo \\$HOME`)).toEqual(["echo", "$HOME"]);
});

test("an unparsable command line says what is wrong instead of guessing", () => {
  expect(splitCommand(`edit "unterminated`)).toEqual({
    problem: "the command has an unterminated double quote",
  });
  expect(splitCommand("edit \\")).toEqual({ problem: "the command ends with a backslash" });
  expect(splitCommand("   ")).toEqual({ problem: "the command is empty" });
  expect(placeholderProblem(["code", "--goto", "{file}:{lineno}"])).toBe(
    "unknown placeholder {lineno}; use {file}, {line} or {column}",
  );
  expect(placeholderProblem(["code", "--goto", "{file}:{line}:{column}"])).toBeUndefined();
});

test("a placeholder-free command gets the file appended; placeholders are filled in", () => {
  expect(fillEditorArgv(["nvim"], { file: "/ws/src/a.ts", line: 12 })).toEqual([
    "nvim",
    "/ws/src/a.ts",
  ]);
  expect(
    fillEditorArgv(["code", "--goto", "{file}:{line}:{column}"], {
      file: "/ws/src/a.ts",
      line: 12,
      column: 3,
    }),
  ).toEqual(["code", "--goto", "/ws/src/a.ts:12:3"]);
  // A position nobody named is the top of the file, not an empty argument.
  expect(fillEditorArgv(["nvim", "+{line}", "{file}"], { file: "/ws/a.ts" })).toEqual([
    "nvim",
    "+1",
    "/ws/a.ts",
  ]);
});

test("the environment decides only when the config key is silent, VISUAL before EDITOR", () => {
  const env = { VISUAL: "code --wait", EDITOR: "nvim" };
  expect(editorSources("", env).map((source) => source.label)).toEqual(["$VISUAL", "$EDITOR"]);
  expect(editorSources("hx", env).map((source) => source.label)).toEqual([
    "[editor] command",
    "$VISUAL",
    "$EDITOR",
  ]);
  // An empty value opts out of that layer, as X11's lookup does.
  expect(editorSources("", { VISUAL: " ", EDITOR: "nvim" }).map((s) => s.label)).toEqual([
    "$EDITOR",
  ]);
  expect(editorSources("", {})).toEqual([]);

  const target = { file: "/ws/a.ts", line: 4 };
  expect(resolveEditorCommand(editorSources("hx", env), target)).toEqual({
    command: "hx",
    args: ["/ws/a.ts"],
  });
  expect(resolveEditorCommand(editorSources("", env), target)).toEqual({
    command: "code",
    args: ["--wait", "/ws/a.ts"],
  });
  expect(resolveEditorCommand(editorSources("", {}), target)).toBeUndefined();
});

test("a broken layer is named and the next one is tried", () => {
  const target = { file: "/ws/a.ts" };
  const broken = { VISUAL: `code "unterminated`, EDITOR: "nvim" };
  expect(resolveEditorCommand(editorSources("", broken), target)).toEqual({
    command: "nvim",
    args: ["/ws/a.ts"],
  });
  // With nothing usable left, the refusal keeps the reason and the layer it came from.
  const only = resolveEditorCommand(editorSources("", { VISUAL: `code "unterminated` }), target);
  expect(only).toEqual({
    problem: `$VISUAL: the command has an unterminated double quote`,
  });
  expect(primaryReason(only, editorSources("", { VISUAL: `code "x` }))).toContain("$VISUAL");
});

function primaryReason(
  resolved: ReturnType<typeof resolveEditorCommand>,
  sources: ReturnType<typeof editorSources>,
): string {
  return editorUnsetReason(
    sources,
    resolved !== undefined && "problem" in resolved ? resolved : undefined,
  );
}
