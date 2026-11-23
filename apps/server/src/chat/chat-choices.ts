import type {
  ChatModelRef,
  ChatModelSelection,
  ChatQueuedMessage,
  ChatQueueStatus,
} from "@corral/protocol/chat";
import type { AgentKind } from "@corral/protocol/config";
import { modelKey, modelScopeKey } from "@corral/protocol/models";

/**
 * The agent instance a session runs. A thinking choice is remembered per agent, profile, provider
 * and model, so choosing a model in one profile never reuses another profile's level.
 */
export interface ChatChoiceScope {
  kind: AgentKind;
  profileId: string | null;
}

/**
 * The chat choices the server owns rather than a driver: the selection each session keeps, the
 * level last explicitly chosen for a model, and the queue of later turns. It is kept apart from
 * the launch snapshot, which stays the immutable record of how the conversation was opened.
 */
export interface ChatChoiceStore {
  /** The session's next-turn selection, or `null` when it has none. */
  selection(sessionId: string): ChatModelSelection | null;
  setSelection(sessionId: string, selection: ChatModelSelection): void;
  /** The level last explicitly chosen for this scope and model, or `null` when none was. */
  rememberedLevel(scope: ChatChoiceScope, model: ChatModelRef): string | null;
  rememberLevel(scope: ChatChoiceScope, model: ChatModelRef, level: string): void;
  /** The session's queued turns, oldest first. */
  queue(sessionId: string): ChatQueuedMessage[];
  enqueue(sessionId: string, message: ChatQueuedMessage): void;
  setQueueStatus(sessionId: string, id: string, status: ChatQueueStatus): void;
  removeQueued(sessionId: string, id: string): void;
}

/** Whether two refs name the same model; a `null` provider is a value, not a wildcard. */
export function sameModelRef(left: ChatModelRef | null | undefined, right: ChatModelRef): boolean {
  return (
    left !== null && left !== undefined && left.id === right.id && left.provider === right.provider
  );
}

/** One selection as a comparable value, for deciding whether a choice changed. */
export function selectionKey(selection: ChatModelSelection): string {
  return `${modelKey(selection.model)}/${selection.level ?? ""}`;
}

/**
 * The in-memory store a test or a transport without a database gets. Production runs
 * `SqliteChatChoices`, so a restart keeps the session's choice and the queue.
 */
export class MemoryChatChoices implements ChatChoiceStore {
  readonly #selections = new Map<string, ChatModelSelection>();
  readonly #memory = new Map<string, string>();
  readonly #queues = new Map<string, ChatQueuedMessage[]>();

  selection(sessionId: string): ChatModelSelection | null {
    return this.#selections.get(sessionId) ?? null;
  }

  setSelection(sessionId: string, selection: ChatModelSelection): void {
    this.#selections.set(sessionId, selection);
  }

  rememberedLevel(scope: ChatChoiceScope, model: ChatModelRef): string | null {
    return this.#memory.get(memoryKey(scope, model)) ?? null;
  }

  rememberLevel(scope: ChatChoiceScope, model: ChatModelRef, level: string): void {
    this.#memory.set(memoryKey(scope, model), level);
  }

  queue(sessionId: string): ChatQueuedMessage[] {
    return [...(this.#queues.get(sessionId) ?? [])];
  }

  enqueue(sessionId: string, message: ChatQueuedMessage): void {
    this.#queues.set(sessionId, [...this.queue(sessionId), message]);
  }

  setQueueStatus(sessionId: string, id: string, status: ChatQueueStatus): void {
    const queue = this.queue(sessionId);
    const index = queue.findIndex((entry) => entry.id === id);
    if (index >= 0) queue[index] = { ...queue[index]!, status };
    this.#queues.set(sessionId, queue);
  }

  removeQueued(sessionId: string, id: string): void {
    this.#queues.set(
      sessionId,
      this.queue(sessionId).filter((entry) => entry.id !== id),
    );
  }
}

function memoryKey(scope: ChatChoiceScope, model: ChatModelRef): string {
  return `${modelScopeKey(scope)}\n${modelKey(model)}`;
}
