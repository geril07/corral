import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { openDatabase } from "../storage/database.ts";
import { SessionStore } from "./session-store.ts";

test("a failed first-turn choice does not leave a resumable session with its default", async () => {
  const root = await mkdtemp(join(tmpdir(), "corral-session-start-"));
  const db = openDatabase(root);
  try {
    db.exec(`
      INSERT INTO projects (id, name, path, default_base_branch) VALUES ('p', 'p', '/p', 'main');
      INSERT INTO tasks (id, project_id, title, workspace_path, owns_worktree, state, created_at)
        VALUES ('t', 'p', 't', '/p', 0, 'active', 1);
    `);
    const store = new SessionStore(db);
    expect(() =>
      store.insert(
        {
          id: "s",
          taskId: "t",
          kind: "pi",
          view: "chat",
          state: "running",
          agentSessionId: "native",
          createdAt: 1,
          label: null,
          launch: null,
        },
        null,
        () => {
          db.prepare(
            "INSERT INTO chat_session_selections (session_id, selection, updated_at) VALUES (?, ?, ?)",
          ).run("s", "{}", 1);
          throw new Error("choice failed");
        },
      ),
    ).toThrow("choice failed");
    expect(store.get("s")).toBeUndefined();
    expect(db.prepare("SELECT session_id FROM chat_session_selections").all()).toEqual([]);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
