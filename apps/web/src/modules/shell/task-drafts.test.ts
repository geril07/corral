import { expect, test } from "vite-plus/test";
import type { LaunchSelection } from "../sessions/index.ts";
import type { TaskComposerDraft } from "../tasks/index.ts";
import { recordOf } from "./json-record.ts";
import {
  draftForProject,
  draftHasContent,
  newTaskDraft,
  parseDrafts,
  serializeDrafts,
  updateDraftComposer,
  type TaskDraft,
} from "./task-drafts.ts";

const AGENT: LaunchSelection = {
  kind: "pi",
  profile: { id: "gateway", name: "Gateway", revision: "rev-1", model: "stub-1", provider: "acme" },
  model: "stub-2",
};

function draft(projectId: string | null, composer: Partial<TaskComposerDraft> = {}): TaskDraft {
  const created = newTaskDraft(projectId, AGENT);
  return { ...created, composer: { ...created.composer, ...composer } };
}

test("a draft round-trips its prompt, project and composer choices", () => {
  const original = draft("project-a", {
    prompt: "Fix the flaky login test",
    workspaceKey: "new-worktree",
    baseBranch: "feature/x",
  });

  const parsed = parseDrafts(serializeDrafts([original]));

  expect(parsed).toHaveLength(1);
  expect(parsed?.[0]?.id).toBe(original.id);
  expect(parsed?.[0]?.composer).toEqual(original.composer);
});

test("a draft with nothing typed is not written", () => {
  const typed = draft("project-a", { prompt: "Keep this" });
  const empty = draft("project-b");

  expect(draftHasContent(empty)).toBe(false);
  const parsed = parseDrafts(serializeDrafts([empty, typed]));

  expect(parsed?.map((entry) => entry.composer.prompt)).toEqual(["Keep this"]);
  // A record written by hand with an empty draft is not resumed either.
  expect(
    parseDrafts(
      JSON.stringify({
        version: 1,
        drafts: [{ id: "empty", composer: { projectId: "project-a", prompt: "  " } }],
      }),
    ),
  ).toEqual([]);
});

test("a record this version cannot read is ignored", () => {
  expect(parseDrafts(null)).toBeUndefined();
  expect(parseDrafts("{not json")).toBeUndefined();
  expect(parseDrafts(JSON.stringify({ version: 2, drafts: [] }))).toBeUndefined();
  expect(parseDrafts(JSON.stringify({ version: 1 }))).toBeUndefined();
});

test("a malformed draft is dropped without losing the rest of the record", () => {
  const good = draft("project-a", { prompt: "Still here" });
  const record = recordOf(JSON.parse(serializeDrafts([good])));
  const drafts = record?.["drafts"];
  if (!Array.isArray(drafts)) throw new Error("the serialized record has no drafts");
  drafts.push(
    { id: "bad-prompt", composer: { projectId: "project-b", prompt: 42 } },
    { id: "bad-agent", composer: { projectId: "project-c", prompt: "x", agent: { kind: "nope" } } },
    { id: "", composer: { projectId: null, prompt: "no id" } },
  );

  const parsed = parseDrafts(JSON.stringify(record));

  expect(parsed?.map((entry) => entry.composer.prompt)).toEqual(["Still here"]);
});

test("New task finds the project's one draft", () => {
  const alpha = draft("project-a", { prompt: "Alpha" });
  const beta = draft("project-b", { prompt: "Beta" });
  const drafts = [alpha, beta];

  expect(draftForProject(drafts, "project-a")).toBe(alpha);
  expect(draftForProject(drafts, "project-b")).toBe(beta);
  expect(draftForProject(drafts, null)).toBeUndefined();
});

test("a draft moved to a project that already has one drops the older duplicate", () => {
  const alpha = draft("project-a", { prompt: "Alpha" });
  const beta = draft("project-b", { prompt: "Beta" });

  const moved = updateDraftComposer([alpha, beta], beta.id, {
    ...beta.composer,
    projectId: "project-a",
  });

  // One draft per project: the older project-a draft is gone and the moved one keeps its text.
  expect(moved.map((entry) => entry.composer.projectId)).toEqual(["project-a"]);
  expect(draftForProject(moved, "project-a")?.composer.prompt).toBe("Beta");
  expect(draftForProject(moved, "project-b")).toBeUndefined();
});

test("a draft moved to No project replaces the older No project draft too", () => {
  const scratch = draft(null, { prompt: "Scratch" });
  const beta = draft("project-b", { prompt: "Beta" });

  const moved = updateDraftComposer([scratch, beta], beta.id, {
    ...beta.composer,
    projectId: null,
  });

  expect(moved.map((entry) => entry.composer.projectId)).toEqual([null]);
  expect(draftForProject(moved, null)?.composer.prompt).toBe("Beta");
});

test("updating a draft that is gone leaves the list as it was", () => {
  const alpha = draft("project-a", { prompt: "Alpha" });
  const beta = draft("project-b", { prompt: "Beta" });
  const drafts = [alpha, beta];

  expect(updateDraftComposer(drafts, "missing", { ...beta.composer, projectId: "project-a" })).toBe(
    drafts,
  );
});
