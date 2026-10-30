/** Every prefix action, bound by the hardcoded map until the config file (MVP step 5). */
export type Action =
  | "new-terminal"
  | "new-agent"
  | "stop-session"
  | "restart-session"
  | "remove-session"
  | "next-session"
  | "previous-session"
  | "new-task"
  | "remove-task"
  | "settle-task"
  | "next-task"
  | "previous-task"
  | "add-project"
  | "board"
  | "jump-blocked";

export const BINDINGS: Readonly<Record<string, Action>> = {
  c: "new-terminal",
  s: "new-agent",
  x: "stop-session",
  r: "restart-session",
  "shift+x": "remove-session",
  n: "next-session",
  p: "previous-session",
  t: "new-task",
  "shift+t": "remove-task",
  d: "settle-task",
  j: "next-task",
  k: "previous-task",
  "shift+p": "add-project",
  b: "board",
  g: "jump-blocked",
};
