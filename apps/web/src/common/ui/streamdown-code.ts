import { getSharedHighlighter, type DiffsHighlighter } from "@pierre/diffs";
import type {
  CodeHighlighterPlugin,
  HighlightOptions,
  HighlightResult,
  ThemeInput,
} from "streamdown";

/**
 * Corral's one highlighter: `@pierre/diffs`' shared Shiki instance backs both Streamdown's code
 * blocks and the diff renderer (goal D1), so a language or theme is loaded once and the two
 * surfaces cannot pick different colors. `@streamdown/code` would ship a second highlighter.
 */
const THEMES = ["pierre-light", "pierre-dark"] as const;
const SUPPORTED_THEMES: ReadonlySet<string> = new Set(THEMES);

/** Enough cached results for a screen of code blocks; a streaming block replaces its own key. */
const CACHE_LIMIT = 80;

interface CachedResult {
  result: HighlightResult;
}

const cache = new Map<string, CachedResult>();

function themeName(theme: ThemeInput): string {
  return typeof theme === "string" ? theme : (theme.name ?? "custom");
}

/**
 * The pair Streamdown passes to `highlight` comes from its `shikiTheme` prop. The highlighter
 * cannot render a theme it has not resolved, so anything outside the pair falls back to the pair
 * the wrapper sets rather than failing the block.
 */
function pairOf(themes: [ThemeInput, ThemeInput]): [string, string] {
  const light = themeName(themes[0]);
  const dark = themeName(themes[1]);
  return [
    SUPPORTED_THEMES.has(light) ? light : THEMES[0],
    SUPPORTED_THEMES.has(dark) ? dark : THEMES[1],
  ];
}

/** A fence name Shiki does not know falls back to `text`; the load failure is not the block's. */
function normalizeLanguage(language: string): string {
  return language.trim().toLowerCase() || "text";
}

let shared: Promise<DiffsHighlighter> | undefined;

function highlighter(): Promise<DiffsHighlighter> {
  shared ??= getSharedHighlighter({ themes: [...THEMES], langs: [] }).catch((error: unknown) => {
    shared = undefined;
    throw error;
  });
  return shared;
}

/**
 * Loads a fence language on demand. @pierre/diffs ships Shiki's bundled grammars and resolves
 * them lazily, so the first block in a language pays one import and later blocks do not.
 */
async function load(language: string): Promise<DiffsHighlighter> {
  const instance = await highlighter();
  if (language !== "text" && !instance.hasLoadedLanguages([language])) {
    await instance.loadLanguages([language]);
  }
  return instance;
}

function toResult(result: ReturnType<DiffsHighlighter["codeToTokens"]>): HighlightResult {
  return {
    tokens: result.tokens.map((line) =>
      line.map((token) => ({
        content: token.content,
        ...(token.color === undefined ? {} : { color: token.color }),
        ...(token.bgColor === undefined ? {} : { bgColor: token.bgColor }),
        ...(token.htmlStyle === undefined ? {} : { htmlStyle: token.htmlStyle }),
        ...(token.htmlAttrs === undefined ? {} : { htmlAttrs: token.htmlAttrs }),
        ...(token.offset === undefined ? {} : { offset: token.offset }),
      })),
    ),
    ...(result.fg === undefined ? {} : { fg: result.fg }),
    ...(result.bg === undefined ? {} : { bg: result.bg }),
    ...(result.rootStyle === undefined ? {} : { rootStyle: result.rootStyle }),
  };
}

function cacheKey(code: string, language: string, [light, dark]: [string, string]): string {
  return `${language}\u0000${light}\u0000${dark}\u0000${code}`;
}

function remember(key: string, result: HighlightResult): void {
  cache.set(key, { result });
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Streamdown's `CodeHighlighterPlugin` over the shared `@pierre/diffs` highlighter. Loading a
 * grammar is asynchronous, so the first call for a language returns `null` and hands the result
 * to the callback Streamdown provides; later calls are synchronous from the cache.
 */
export const pierreCodePlugin: CodeHighlighterPlugin = {
  name: "shiki",
  type: "code-highlighter",
  getSupportedLanguages() {
    // @pierre/diffs resolves Shiki's bundled grammars on demand instead of shipping one list.
    return [];
  },
  getThemes() {
    return [THEMES[0], THEMES[1]];
  },
  supportsLanguage(language) {
    return language.trim() !== "";
  },
  highlight(options: HighlightOptions, callback?: (result: HighlightResult) => void) {
    const pair = pairOf(options.themes);
    const language = normalizeLanguage(options.language);
    const key = cacheKey(options.code, language, pair);
    const cached = cache.get(key);
    if (cached !== undefined) return cached.result;

    load(language)
      .then((instance) => {
        const usable = instance.hasLoadedLanguages([language]) ? language : "text";
        const result = toResult(
          instance.codeToTokens(options.code, {
            lang: usable,
            themes: { light: pair[0], dark: pair[1] },
          }),
        );
        remember(key, result);
        callback?.(result);
      })
      .catch((error: unknown) => {
        // A grammar that fails to load is not worth failing a message over: Streamdown keeps the
        // block unhighlighted and the user still reads the code.
        console.error("code highlight failed", error);
      });
    return null;
  },
};
