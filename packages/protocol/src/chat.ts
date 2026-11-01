import { z } from "zod";

/**
 * Corral's own chat contract (design.md, decision 14): the server owns the state of an agent
 * session shown as chat and streams it as one snapshot followed by sequenced events. Clients
 * render that; a provider protocol (pi's RPC mode, later OpenCode, Claude Code or Codex) never
 * leaves the server's driver.
 *
 * Items have stable ids. The snapshot is the whole timeline; later events replace an item by id,
 * append streamed text to one, or replace the session-level state. Sequence numbers are per
 * session and contiguous, so a client that reconnects with its last sequence asks
 * `chat.watch({ after })` and either gets the missing events or, when the server no longer holds
 * them, a fresh snapshot. A hole in a live stream means the client must ask for a snapshot again.
 *
 * The transcript is the agent's own session, not Corral's: this contract carries no history
 * endpoint and no persistence (roadmap.md, **Decision boundaries**).
 */

/** Stable id of one item in a session's chat. Reusing it replaces that item. */
export const ChatItemId = z.string().min(1);
export type ChatItemId = z.infer<typeof ChatItemId>;

/** Text the user sent. Images and attachments come later. */
export const ChatUserMessage = z.object({
  kind: z.literal("user-message"),
  id: ChatItemId,
  text: z.string(),
});
export type ChatUserMessage = z.infer<typeof ChatUserMessage>;

/** The agent's answer. `streaming` is true until the agent's final text for it arrives. */
export const ChatAssistantMessage = z.object({
  kind: z.literal("assistant-message"),
  id: ChatItemId,
  text: z.string(),
  streaming: z.boolean(),
});
export type ChatAssistantMessage = z.infer<typeof ChatAssistantMessage>;

/** The agent's thinking, when it exposes it; `streaming` as on an assistant message. */
export const ChatReasoning = z.object({
  kind: z.literal("reasoning"),
  id: ChatItemId,
  text: z.string(),
  streaming: z.boolean(),
});
export type ChatReasoning = z.infer<typeof ChatReasoning>;

export const ChatToolStatus = z.enum(["running", "done", "error"]);
export type ChatToolStatus = z.infer<typeof ChatToolStatus>;

/**
 * A file change a tool call made, for the client's diff renderer. One shape for every driver:
 * the unified diff of one file, or of the whole change when the path is not known.
 */
export const ChatDiff = z.object({
  /** Path as the agent reported it; relative to the task's workspace when it gave a relative one. */
  path: z.string().nullable(),
  /** Unified diff text (`---`/`+++` headers and hunks). */
  text: z.string(),
});
export type ChatDiff = z.infer<typeof ChatDiff>;

/**
 * A call the agent made. `arguments` stays text: each tool takes its own JSON shape, and the
 * client shows it rather than acting on it. Render a call by its shape — a `diff` renders as a
 * diff, any other result as text — never by `name`, which is the driver's label for its tool and
 * changes with the agent.
 */
export const ChatToolCall = z.object({
  kind: z.literal("tool-call"),
  id: ChatItemId,
  name: z.string().min(1),
  arguments: z.string(),
  status: ChatToolStatus,
  /**
   * Result text; may carry partial output while `status` is `running` and each update replaces it
   * whole (drivers send replacements, not deltas); `null` while there is none or the tool returns
   * nothing.
   */
  output: z.string().nullable(),
  /** The change it made, when it made one; `null` for a read, a command or a failure. */
  diff: ChatDiff.nullable(),
});
export type ChatToolCall = z.infer<typeof ChatToolCall>;

/** What the agent waits for: pick one answer, confirm, type a line, or write a longer text. */
export const ChatRequestKind = z.enum(["select", "confirm", "input", "editor"]);
export type ChatRequestKind = z.infer<typeof ChatRequestKind>;

/** The answer to a user request: text or a choice, a boolean for `confirm`, `null` to dismiss. */
export const ChatAnswer = z.union([z.string(), z.boolean(), z.null()]);
export type ChatAnswer = z.infer<typeof ChatAnswer>;

/** `pending` until the user answers or the server stops waiting; then the item is replaced. */
export const ChatRequestStatus = z.enum(["pending", "answered", "expired"]);
export type ChatRequestStatus = z.infer<typeof ChatRequestStatus>;

/** One answer a `select` offers. */
export const ChatRequestOption = z.object({
  value: z.string(),
  label: z.string(),
  description: z.string().optional(),
});
export type ChatRequestOption = z.infer<typeof ChatRequestOption>;

/**
 * A question the agent is blocked on. It is an item like any other, so it keeps its place in the
 * timeline once answered, and `chat.respond` addresses it by `id`.
 */
export const ChatUserRequest = z.object({
  kind: z.literal("user-request"),
  id: ChatItemId,
  /** The kind of answer the agent waits for. */
  request: ChatRequestKind,
  /** The short question, shown as the request's heading. */
  title: z.string(),
  /** The longer explanation the agent gave (`confirm`'s message, an `input`'s prompt); `null` if none. */
  body: z.string().nullable(),
  /** The choices of a `select`; empty for the other kinds. */
  options: z.array(ChatRequestOption),
  /** Hint text for `input`; `null` when the request has none. */
  placeholder: z.string().nullable(),
  /** Text an `editor` starts with; `null` when it starts empty. */
  prefill: z.string().nullable(),
  /**
   * Epoch milliseconds after which the server stops waiting and the request expires; `null` when
   * the driver set no deadline. The server enforces it, because an agent's own timeout is local.
   */
  expiresAt: z.number().nullable(),
  status: ChatRequestStatus,
  /**
   * What the user answered, recorded for a client that watches later; absent until `status` is
   * `answered`, where `null` means the user dismissed the request. `chat.respond` returns void.
   */
  answer: ChatAnswer.optional(),
});
export type ChatUserRequest = z.infer<typeof ChatUserRequest>;

/** A quiet line from the agent or the driver (a compaction, a retry, a status note). */
export const ChatNotice = z.object({
  kind: z.literal("notice"),
  id: ChatItemId,
  text: z.string(),
});
export type ChatNotice = z.infer<typeof ChatNotice>;

/** Something that went wrong in the session, safe to show. */
export const ChatError = z.object({
  kind: z.literal("error"),
  id: ChatItemId,
  text: z.string(),
});
export type ChatError = z.infer<typeof ChatError>;

export const ChatItem = z.discriminatedUnion("kind", [
  ChatUserMessage,
  ChatAssistantMessage,
  ChatReasoning,
  ChatToolCall,
  ChatUserRequest,
  ChatNotice,
  ChatError,
]);
export type ChatItem = z.infer<typeof ChatItem>;

/**
 * The current turn. `settled` is the agent's "the run will not continue by itself"; `aborted`
 * means the user stopped it; `error` means the turn failed and an `error` item says why.
 */
export const ChatTurnState = z.enum(["idle", "working", "settled", "aborted", "error"]);
export type ChatTurnState = z.infer<typeof ChatTurnState>;

/** A model the session can run, as `chat.setModel` names it. */
export const ChatModelRef = z.object({
  /** The provider the model belongs to; `null` when the agent does not group models by one. */
  provider: z.string().nullable(),
  id: z.string().min(1),
});
export type ChatModelRef = z.infer<typeof ChatModelRef>;

/** One entry of the session's model list, with what the UI shows for it. */
export const ChatModel = ChatModelRef.extend({
  /** Display name; equals `id` when the agent has no separate one. */
  name: z.string().min(1),
});
export type ChatModel = z.infer<typeof ChatModel>;

/** Everything about a session that is not one item of its timeline. */
export const ChatSessionState = z.object({
  turn: ChatTurnState,
  /** Messages sent to steer the turn the agent is working on, in send order. */
  steering: z.array(z.string()),
  /** Messages queued to run after the current turn, in send order. */
  followUp: z.array(z.string()),
  /** The model in effect; `null` until the driver reports one. */
  model: ChatModel.nullable(),
  /** Every model the driver offers for a switch; includes `model`. */
  models: z.array(ChatModel),
  /** The reasoning level in effect; `null` when the driver has none or has not reported one. */
  reasoning: z.string().nullable(),
  /** Levels the driver accepts, in its order; empty when it has none. */
  reasoningLevels: z.array(z.string()),
});
export type ChatSessionState = z.infer<typeof ChatSessionState>;

/** One change to a session's chat, in sequence order. */
export const ChatEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("item"),
    /**
     * The new item, or the replacement of the one with the same id. A new item is always appended;
     * a replacement keeps its place, and the snapshot's order is authoritative.
     */
    item: ChatItem,
  }),
  z.object({
    type: z.literal("delta"),
    /**
     * The assistant message or reasoning item the text appends to. A delta whose item is missing
     * or of another kind is a hole in the client's state, so the client must resnapshot.
     */
    itemId: ChatItemId,
    text: z.string(),
  }),
  z.object({
    type: z.literal("state"),
    /** Replaces the whole session state; it is small and never partial. */
    state: ChatSessionState,
  }),
]);
export type ChatEvent = z.infer<typeof ChatEvent>;

/** A whole timeline at one sequence, the starting point of a watch. */
export const ChatSnapshot = z.object({
  /** The last sequence the snapshot covers; the next event is `sequence + 1`. */
  sequence: z.number().int().nonnegative(),
  state: ChatSessionState,
  /** The timeline, oldest first. */
  items: z.array(ChatItem),
});
export type ChatSnapshot = z.infer<typeof ChatSnapshot>;

/** What `chat.watch` yields: a snapshot when it starts (or when it cannot replay), else events. */
export const ChatStreamMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), snapshot: ChatSnapshot }),
  z.object({
    type: z.literal("event"),
    /** One more than the sequence before it, starting at 1. A hole means the client must resnapshot. */
    sequence: z.number().int().positive(),
    event: ChatEvent,
  }),
]);
export type ChatStreamMessage = z.infer<typeof ChatStreamMessage>;
