import { expect, test } from "vite-plus/test";
import { MAX_NAMING_PROMPT_CHARS, namingPrompt } from "./naming-prompt.ts";

test("the request is carried as a JSON string and cut at 8000 characters", () => {
  const prompt = "p".repeat(MAX_NAMING_PROMPT_CHARS + 500);

  const template = namingPrompt({ prompt, projectName: "app", generatedSlug: false });

  expect(template).toContain(JSON.stringify("p".repeat(MAX_NAMING_PROMPT_CHARS)));
  expect(template).not.toContain(JSON.stringify("p".repeat(MAX_NAMING_PROMPT_CHARS + 1)));
});

test("title mode asks for a title alone, generated mode also asks for the branch and worktree", () => {
  const title = namingPrompt({ prompt: "Add OAuth", projectName: "app", generatedSlug: false });
  const generated = namingPrompt({
    prompt: "Add OAuth",
    projectName: "app",
    generatedSlug: true,
  });

  expect(title).toContain('{"title": "…"}');
  expect(title).not.toContain('"branch"');
  expect(generated).toContain('{"title": "…", "branch": "…", "worktree": "…"}');
  expect(generated).toContain("at most 40 characters");
});

test("the project name and the outcome rule travel with the request", () => {
  const template = namingPrompt({
    prompt: "Add OAuth",
    projectName: "corral",
    generatedSlug: false,
  });

  expect(template).toContain("Project: corral");
  expect(template).toContain("3 to 8 words");
  expect(template).toContain("naming the outcome");
});
