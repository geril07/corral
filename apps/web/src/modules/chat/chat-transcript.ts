/**
 * What one session's transcript keeps for as long as the session is open: the row the user was
 * reading and the folds they opened. The workspace owns one store per session, beside the composer
 * draft (`task-workspace.tsx`), because a tab switch unmounts the pane and a fresh mount must not
 * read as a fresh session.
 */
export interface ChatTranscriptMemory {
  /** Where the user was reading. A remount restores this row rather than a pixel offset: the rows
   * are measured again, so the same pixel would land on a different line. */
  anchor: ChatTranscriptAnchor | undefined;
  /** Whether the view was at the end when it was left, so coming back resumes the end follow. */
  atEnd: boolean;
  /** Keys of the folds the user opened (`turn:<id>`, `group:<id>`, and a row's own id). */
  expanded: ReadonlySet<string>;
}

/** The row under the top edge of the viewport: the one the user was reading. */
export interface ChatTranscriptAnchor {
  key: string;
  /** The row's index when it was remembered, so a row that no longer exists restores near it. */
  index: number;
}

/**
 * One session's memory. It is written from outside React — a scroll must not re-render the
 * workspace — and read when the pane mounts again, so it holds plain immutable snapshots instead
 * of being a prop the pane mutates.
 */
export interface ChatTranscriptStore {
  read(): ChatTranscriptMemory;
  /** Remembers the row at the top edge and whether the view was at the end; called on scroll. */
  remember(anchor: ChatTranscriptAnchor, atEnd: boolean): void;
  /** Opens or closes one fold and answers the set of open folds. */
  toggle(key: string): ReadonlySet<string>;
}

export function chatTranscriptStore(): ChatTranscriptStore {
  let memory: ChatTranscriptMemory = { anchor: undefined, atEnd: false, expanded: new Set() };
  return {
    read: () => memory,
    remember: (anchor, atEnd) => {
      memory = { ...memory, anchor, atEnd };
    },
    toggle: (key) => {
      const expanded = new Set(memory.expanded);
      if (expanded.has(key)) expanded.delete(key);
      else expanded.add(key);
      memory = { ...memory, expanded };
      return expanded;
    },
  };
}

/**
 * A quoted selection as Markdown: every line of it as a blockquote, then the blank line the user
 * writes their comment on. Corral v1 sends the quote as plain Markdown rather than a citation
 * token, so no protocol field carries it (`.review/research/chat-transcript.md`, **Quote flow**).
 */
export function quoteBlock(text: string): string {
  const lines = text.split(/\r?\n/u).map((line) => line.trimEnd());
  while (lines[0]?.trim() === "") lines.shift();
  while (lines.at(-1)?.trim() === "") lines.pop();
  if (lines.length === 0) return "";
  return `${lines.map((line) => (line === "" ? ">" : `> ${line}`)).join("\n")}\n\n`;
}

export interface DraftInsertion {
  text: string;
  /** Where the caret goes after the quote, so the comment starts on the line below it. */
  caret: number;
}

/** Inserts a quote at the composer's caret, replacing its selection when it has one. */
export function insertQuote(
  draft: string,
  selection: { start: number; end: number } | undefined,
  quote: string,
): DraftInsertion {
  const start = selection?.start ?? draft.length;
  const end = selection?.end ?? start;
  const before = draft.slice(0, start);
  const block = quoteBlock(quote);
  if (block === "") return { text: draft, caret: start };
  // A quote never continues the user's own sentence: it starts on its own line.
  const lead = before !== "" && !before.endsWith("\n") ? "\n" : "";
  return {
    text: `${before}${lead}${block}${draft.slice(end)}`,
    caret: before.length + lead.length + block.length,
  };
}
