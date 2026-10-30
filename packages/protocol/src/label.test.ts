import { expect, test } from "vite-plus/test";
import { Label, MAX_LABEL_LENGTH, normalizeLabel } from "./label.ts";
import { Session } from "./rpc.ts";

test("a label is trimmed and blank means no label", () => {
  expect(normalizeLabel("  build  ")).toBe("build");
  expect(normalizeLabel("   ")).toBeNull();
  expect(normalizeLabel("")).toBeNull();
  expect(normalizeLabel(null)).toBeNull();
  expect(normalizeLabel(undefined)).toBeNull();
});

test("a label is at most one line of visible text of reasonable length", () => {
  expect(Label.parse("release notes")).toBe("release notes");
  expect(Label.parse("  padded  ")).toBe("padded");
  expect(Label.parse(`  ${"x".repeat(MAX_LABEL_LENGTH)}  `)).toHaveLength(MAX_LABEL_LENGTH);
  expect(() => Label.parse("x".repeat(MAX_LABEL_LENGTH + 1))).toThrow(/80/);
  expect(() => Label.parse("two\nlines")).toThrow(/control characters/);
  expect(() => Label.parse("bell\u0007")).toThrow(/control characters/);
  expect(() => Label.parse(42)).toThrow(/expected string/);
});

test("a peer that predates labels still parses a session", () => {
  const session = Session.parse({
    id: "s",
    taskId: "t",
    kind: "shell",
    agentSessionId: null,
    terminalId: null,
    state: "stopped",
    status: null,
    createdAt: 0,
  });

  expect(session.label).toBeUndefined();
});
