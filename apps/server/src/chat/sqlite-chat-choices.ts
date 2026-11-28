import type {
  ChatModelRef,
  ChatModelSelection,
  ChatQueuedMessage,
  ChatQueueStatus,
} from "@corral/protocol/chat";
import { ChatModelSelection as SelectionSchema } from "@corral/protocol/chat";
import { modelKey, modelScopeKey } from "@corral/protocol/models";
import type { DatabaseSync } from "node:sqlite";
import type { ChatChoiceScope, ChatChoiceStore } from "./chat-choices.ts";

const QUEUE_STATUSES: readonly ChatQueueStatus[] = [
  "queued",
  "sending",
  "accepted",
  "undelivered",
  "uncertain",
  "boundary-unknown",
  "boundary-unverified",
  "uncertain-idle",
  "accepted-idle",
  "completed",
];

/**
 * The server's durable chat choices (`chat_session_selections`, `chat_thinking_memory`,
 * `chat_queue`). A choice this build cannot read is treated as absent instead of keeping a session
 * from starting, because the transcript is rebuilt from the agent regardless; a queue row keeps its
 * text even when its captured selection no longer parses, so nothing the user wrote disappears.
 *
 * Opening the store is also the recovery point for a server that died with work queued. A
 * `sending` row may have reached the agent, so it becomes `uncertain`; a `queued` row followed a
 * turn whose outcome the restarted server cannot observe, so it becomes `undelivered`. Neither is
 * sent again on its own.
 */
export class SqliteChatChoices implements ChatChoiceStore {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec("UPDATE chat_queue SET status = 'uncertain' WHERE status = 'sending'");
    db.exec("UPDATE chat_queue SET status = 'boundary-unknown' WHERE status = 'accepted'");
    db.exec("UPDATE chat_queue SET status = 'undelivered' WHERE status = 'queued'");
  }

  selection(sessionId: string): ChatModelSelection | null {
    const row = this.#db
      .prepare("SELECT selection FROM chat_session_selections WHERE session_id = ?")
      .get(sessionId);
    if (typeof row?.["selection"] !== "string") return null;
    return parseJson(row["selection"], (value) => SelectionSchema.safeParse(value));
  }

  setSelection(sessionId: string, selection: ChatModelSelection): void {
    this.#db
      .prepare(
        `INSERT INTO chat_session_selections (session_id, selection, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET selection = excluded.selection,
           updated_at = excluded.updated_at`,
      )
      .run(sessionId, JSON.stringify(selection), Date.now());
  }

  rememberedLevel(scope: ChatChoiceScope, model: ChatModelRef): string | null {
    const row = this.#db
      .prepare("SELECT level FROM chat_thinking_memory WHERE scope = ? AND model = ?")
      .get(modelScopeKey(scope), modelKey(model));
    return typeof row?.["level"] === "string" ? row["level"] : null;
  }

  rememberLevel(scope: ChatChoiceScope, model: ChatModelRef, level: string): void {
    this.#db
      .prepare(
        `INSERT INTO chat_thinking_memory (scope, model, level, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(scope, model) DO UPDATE SET level = excluded.level,
           updated_at = excluded.updated_at`,
      )
      .run(modelScopeKey(scope), modelKey(model), level, Date.now());
  }

  queue(sessionId: string): ChatQueuedMessage[] {
    const rows = this.#db
      .prepare(
        "SELECT id, text, selection, status FROM chat_queue WHERE session_id = ? ORDER BY rowid",
      )
      .all(sessionId);
    return rows.flatMap((row): ChatQueuedMessage[] => {
      const id = typeof row["id"] === "string" ? row["id"] : undefined;
      const text = typeof row["text"] === "string" ? row["text"] : undefined;
      const stored = QUEUE_STATUSES.find((each) => each === row["status"]) ?? "undelivered";
      if (id === undefined || text === undefined) return [];
      const selection =
        typeof row["selection"] === "string"
          ? parseJson(row["selection"], (value) => SelectionSchema.safeParse(value))
          : null;
      // An unreadable row is still a message the user wrote: keep its text visible rather than
      // dropping it. Its captured choice is not a choice any more, so a runnable row becomes one
      // the server will never send by itself instead of letting the turn run on the current model.
      const status =
        selection === null && typeof row["selection"] === "string" && stored === "queued"
          ? "undelivered"
          : stored;
      return [{ id, text, selection, status }];
    });
  }

  enqueue(sessionId: string, message: ChatQueuedMessage): void {
    this.#db
      .prepare(
        `INSERT INTO chat_queue (id, session_id, text, selection, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        sessionId,
        message.text,
        message.selection === null ? null : JSON.stringify(message.selection),
        message.status,
        Date.now(),
      );
  }

  setQueueStatus(sessionId: string, id: string, status: ChatQueueStatus): void {
    this.#db
      .prepare("UPDATE chat_queue SET status = ? WHERE id = ? AND session_id = ?")
      .run(status, id, sessionId);
  }

  removeQueued(sessionId: string, id: string): void {
    this.#db.prepare("DELETE FROM chat_queue WHERE id = ? AND session_id = ?").run(id, sessionId);
  }
}

/**
 * A stored value that no longer parses is treated as absent. It came from this build, so this is
 * defensive: refusing to start a chat over one row would trade a missing choice for no chat.
 */
function parseJson<T>(
  text: string,
  parse: (value: unknown) => { success: true; data: T } | { success: false },
): T | null {
  try {
    const result = parse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
