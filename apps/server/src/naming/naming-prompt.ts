/** The most prompt text one naming request carries; the rest is dropped. */
export const MAX_NAMING_PROMPT_CHARS = 8000;

/**
 * The one prompt template for a naming request. It asks for a single JSON object: the title
 * always, the branch and worktree slugs only when Corral will name a worktree from them. The
 * request is embedded as a JSON string so its own quotes and braces cannot be read as the answer.
 */
export function namingPrompt(options: {
  prompt: string;
  projectName: string;
  generatedSlug: boolean;
}): string {
  const request = Array.from(options.prompt).slice(0, MAX_NAMING_PROMPT_CHARS).join("");
  const shape = options.generatedSlug
    ? '{"title": "…", "branch": "…", "worktree": "…"}'
    : '{"title": "…"}';
  const rules = options.generatedSlug
    ? [
        "- title: 3 to 8 words, under 40 characters, naming the outcome; do not copy the request.",
        '- branch and worktree: one lowercase slug of ASCII letters, digits and "-", at most 40 characters, without the project\'s branch prefix.',
      ]
    : "- title: 3 to 8 words, under 40 characters, naming the outcome; do not copy the request.";
  return [
    "Name the coding task described below before its agent starts.",
    `Reply with one JSON object and nothing else, in this shape: ${shape}`,
    rules,
    `Project: ${options.projectName}`,
    "The request, as a JSON string:",
    JSON.stringify(request),
  ].join("\n");
}
