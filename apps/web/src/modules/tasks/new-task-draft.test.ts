import { describe, expect, test } from "vite-plus/test";
import { draftForProject, emptyDraft, movedDraft, type ComposerDraft } from "./new-task-draft.ts";
import { MAIN_TREE, branchKey } from "./new-task-defaults.ts";

const source = {
  provider: "github" as const,
  host: "github.com",
  repository: "acme/app",
  number: 7,
  url: "https://github.com/acme/app/issues/7",
  title: "Issue title",
  body: "Issue body",
  fetchedAt: 1_700_000_000_000,
};

function draft(overrides: Partial<ComposerDraft> = {}): ComposerDraft {
  return { ...emptyDraft("p1"), ...overrides };
}

describe("movedDraft", () => {
  test("keeps the user's own text and picks", () => {
    const moved = movedDraft(
      draft({
        prompt: "Fix it",
        promptTyped: true,
        title: "My title",
        titleOpen: true,
        agentKey: "native:pi",
        workspaceKey: MAIN_TREE,
      }),
      "p2",
    );

    expect(moved).toMatchObject({
      projectId: "p2",
      prompt: "Fix it",
      promptTyped: true,
      title: "My title",
      titleOpen: true,
      agentKey: "native:pi",
      workspaceKey: MAIN_TREE,
    });
  });

  test("drops what only the old project owned: the source, an imported prompt and a branch", () => {
    const moved = movedDraft(
      draft({
        prompt: "Issue title\n\nhttps://example.test/7",
        promptTyped: false,
        source,
        workspaceKey: branchKey("feature/x"),
      }),
      "p2",
    );

    expect(moved.prompt).toBe("");
    expect(moved.promptTyped).toBe(false);
    expect(moved.source).toBeUndefined();
    expect(moved.workspaceKey).toBeUndefined();
  });

  test("a draft is only moved for another project", () => {
    const current = draft({ prompt: "Same project", promptTyped: true, source });

    expect(draftForProject(current, "p1")).toBe(current);
    expect(draftForProject(current, "p2")).toMatchObject({
      projectId: "p2",
      prompt: "Same project",
    });
    expect(draftForProject(current, "p2").source).toBeUndefined();
  });
});
