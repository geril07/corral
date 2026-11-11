import { AGENTS } from "@corral/client/session-state";
import type { LaunchSelection } from "../sessions/index.ts";
import { emptyTaskComposerDraft, type TaskComposerDraft } from "../tasks/index.ts";
import { recordOf } from "./json-record.ts";

/**
 * A New task draft: the composer's content and a tab in the working area's main group
 * (`docs/layout.md`, **New task view**). The server owns no draft and receives none; the app keeps
 * one per project on this device, so New task returns to what was typed (`docs/ux.md`).
 */
export interface TaskDraft {
  /** Client-only identity. The draft never reaches the server and has no URL. */
  id: string;
  /**
   * Local incarnation. A draft discarded and opened again for the same project is a new draft,
   * so a create that lands late cannot clear or select for the one that replaced it.
   */
  key: number;
  composer: TaskComposerDraft;
}

/** The device-local record; one document, as the draft store is written as a whole. */
export const TASK_DRAFT_STORAGE_KEY = "corral.task-drafts";

let nextKey = 0;

/** OpenCode's fallback for a context where `randomUUID` is missing or refused. */
function fallbackId(): string {
  return Math.random().toString(16).slice(2);
}

/**
 * A client-only id. `crypto.randomUUID` is secure-context only, and the server has a `--host`
 * option, so the app is reachable over a LAN address where the browser withholds it.
 */
function idOf(): string {
  const crypto = globalThis.crypto;
  if (crypto === undefined || typeof crypto.randomUUID !== "function") return fallbackId();
  if (typeof globalThis.isSecureContext === "boolean" && !globalThis.isSecureContext)
    return fallbackId();
  try {
    return crypto.randomUUID();
  } catch {
    return fallbackId();
  }
}

/** A draft for `projectId` with nothing typed and the launch the composer opened with pinned. */
export function newTaskDraft(
  projectId: string | null,
  agent: LaunchSelection | undefined,
): TaskDraft {
  nextKey += 1;
  return {
    id: idOf(),
    key: nextKey,
    composer: { ...emptyTaskComposerDraft(projectId), agent },
  };
}

/** The draft a stored record resumes: a fresh incarnation, so it owns no in-flight create. */
export function resumedTaskDraft(id: string, composer: TaskComposerDraft): TaskDraft {
  nextKey += 1;
  return { id, key: nextKey, composer };
}

/**
 * The project's draft, if one is open. T3 keeps one draft per project and reuses it, so there is
 * never a second one to choose between (`updateDraftComposer` keeps that invariant).
 */
export function draftForProject(
  drafts: readonly TaskDraft[],
  projectId: string | null,
): TaskDraft | undefined {
  return drafts.find((draft) => draft.composer.projectId === projectId);
}

/**
 * The drafts with `id`'s composer replaced. One draft per project: a composer that moves to a
 * project another draft already names drops that older draft in the same pass, as T3 rehomes the
 * draft to its project key. The updated draft keeps its strip position.
 */
export function updateDraftComposer(
  drafts: readonly TaskDraft[],
  id: string,
  composer: TaskComposerDraft,
): readonly TaskDraft[] {
  if (!drafts.some((draft) => draft.id === id)) return drafts;
  return drafts.flatMap((draft) => {
    if (draft.id === id) return [{ ...draft, composer }];
    return draft.composer.projectId === composer.projectId ? [] : [draft];
  });
}

/**
 * Whether the draft is worth keeping. A draft with nothing typed is not written, so it disappears
 * when it is closed or the page reloads; choices alone do not make it a draft.
 */
export function draftHasContent(draft: Pick<TaskDraft, "composer">): boolean {
  return draft.composer.prompt.trim() !== "";
}

interface StoredDraft {
  id: string;
  composer: TaskComposerDraft;
}

interface StoredDrafts {
  version: 1;
  drafts: StoredDraft[];
}

/** The device-local document: only drafts with something typed, in their strip order. */
export function serializeDrafts(drafts: readonly TaskDraft[]): string {
  const stored: StoredDrafts = {
    version: 1,
    drafts: drafts
      .filter(draftHasContent)
      .map(({ id, composer }) => ({ id, composer: storedComposer(composer) })),
  };
  return JSON.stringify(stored);
}

function storedComposer(composer: TaskComposerDraft): TaskComposerDraft {
  return {
    projectId: composer.projectId,
    prompt: composer.prompt,
    agent: composer.agent,
    workspaceKey: composer.workspaceKey,
    baseBranch: composer.baseBranch,
  };
}

/** A stored record, or `undefined` when it is absent, another version or malformed. */
export function parseDrafts(raw: string | null): TaskDraft[] | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const record = recordOf(parsed);
  if (record === undefined) return undefined;
  if (record["version"] !== 1 || !Array.isArray(record["drafts"])) return undefined;
  return record["drafts"].flatMap((value) => {
    const entry = recordOf(value);
    if (entry === undefined) return [];
    const id = entry["id"];
    const composer = readComposer(entry);
    if (typeof id !== "string" || id === "" || composer === undefined) return [];
    const draft = resumedTaskDraft(id, composer);
    // The store only holds drafts with something typed; an empty entry is not resumed.
    return draftHasContent(draft) ? [draft] : [];
  });
}

function readComposer(entry: Record<string, unknown>): TaskComposerDraft | undefined {
  const composer = recordOf(entry["composer"]);
  if (composer === undefined) return undefined;
  const projectId = composer["projectId"];
  const prompt = composer["prompt"];
  if (projectId !== null && typeof projectId !== "string") return undefined;
  if (typeof prompt !== "string") return undefined;
  const workspaceKey = composer["workspaceKey"];
  const baseBranch = composer["baseBranch"];
  if (!isOptionalString(workspaceKey) || !isOptionalString(baseBranch)) return undefined;
  const agent = readLaunchSelection(composer["agent"]);
  if (composer["agent"] !== undefined && agent === undefined) return undefined;
  return {
    projectId,
    prompt,
    agent,
    workspaceKey,
    baseBranch,
  };
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/** A pinned launch survives a reload; an unknown agent or a malformed profile is dropped. */
function readLaunchSelection(value: unknown): LaunchSelection | undefined {
  const record = recordOf(value);
  if (record === undefined) return undefined;
  const kind = AGENTS.find((agent) => agent === record["kind"]);
  const model = record["model"];
  if (kind === undefined || typeof model !== "string") return undefined;
  if (record["profile"] === null) return { kind, profile: null, model };
  const profile = recordOf(record["profile"]);
  if (profile === undefined) return undefined;
  const { id, name, revision, model: profileModel, provider } = profile;
  if (typeof id !== "string" || typeof name !== "string" || typeof revision !== "string")
    return undefined;
  if (profileModel !== null && typeof profileModel !== "string") return undefined;
  if (provider !== null && typeof provider !== "string") return undefined;
  return { kind, profile: { id, name, revision, model: profileModel, provider }, model };
}
