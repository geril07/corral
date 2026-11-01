import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import type { ChangeDiff, TaskChanges } from "@corral/protocol/rpc";
import { eventually, useServer } from "../test/server-fixture.ts";
import { runGit } from "../test/git-repo.ts";
import { createChangesStore, type ChangesSource } from "./changes-store.ts";
import type { ConnectionState } from "./connection-state.ts";
import { Store } from "./store.ts";

const server = useServer();

test("the store follows a task's changed files, recomputes on refresh and returns a file's diff", async () => {
  const setup = await server.connected();
  const { api } = setup.connection;
  const project = await api.projects.add({ path: server.repo() });
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Changes",
    workspace: { type: "new-branch" },
  });

  // A client that connects now gets the task in its first list, a clean one included.
  const client = await server.connected();
  // The watch lists every task, a clean one included.
  await eventually(() => expect(client.changes.getSnapshot().loaded).toBe(true));
  expect(client.changes.getSnapshot().byTask.get(task.id)?.files).toEqual([]);
  expect(client.changes.getSnapshot().failed).toBe(false);

  writeFileSync(join(task.workspacePath, "notes.txt"), "one\ntwo\n");

  // The watch cannot see a write nobody told the server about; refresh is the pull that can.
  await client.changes.refresh(task.id);
  const refreshed = client.changes.getSnapshot().byTask.get(task.id);
  expect(refreshed?.files).toMatchObject([
    { path: "notes.txt", status: "A", additions: 2, deletions: 0 },
  ]);
  // The store's other entries stay as they were: a refresh merges one task, not the whole list.
  expect(client.changes.getSnapshot().byTask.size).toBe(1);

  const diff = await client.changes.diff(task.id, "notes.txt");
  expect(diff.text).toContain("+one");
  expect(diff.binary).toBe(false);

  await expect(client.changes.diff(task.id, "missing.txt")).rejects.toMatchObject({
    code: "CHANGES_FILE_UNKNOWN",
  });
});

test("the store tells a task that cannot be read apart from a clean one", async () => {
  const client = await server.connected();
  const { api } = client.connection;
  const project = await api.projects.add({ path: server.repo() });
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Gone",
    workspace: { type: "new-branch" },
  });
  runGit(project.path, "worktree", "remove", "--force", task.workspacePath);

  await client.changes.refresh(task.id);

  const snapshot = client.changes.getSnapshot().byTask.get(task.id);
  expect(snapshot?.files).toEqual([]);
  expect(snapshot?.error).toContain(task.workspacePath);
});

test("a refused watch marks changes unavailable, and the next watch that yields clears it", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const state = new Store<ConnectionState>({ status: "connecting" });
  let attempts = 0;
  const source: ChangesSource = {
    state,
    watch: async () => {
      attempts += 1;
      // The first watch refuses the way a daemon from before C4 does: no such procedure.
      if (attempts === 1) throw new Error("Not Found");
      return (async function* () {
        yield [] as readonly TaskChanges[];
      })();
    },
    files: async () => {
      throw new Error("refresh was not expected");
    },
    diff: async () => {
      throw new Error("diff was not expected");
    },
  };
  const store = createChangesStore(source);
  try {
    expect(store.getSnapshot()).toEqual({ loaded: false, byTask: new Map(), failed: false });

    state.set({ status: "connected" });
    await eventually(() => expect(store.getSnapshot().failed).toBe(true));
    expect(store.getSnapshot().loaded).toBe(true);

    // A dropped socket is not a verdict about the server: the next connection's watch yields.
    state.set({ status: "disconnected" });
    state.set({ status: "connected" });
    await eventually(() => expect(store.getSnapshot().failed).toBe(false));
    expect(attempts).toBeGreaterThanOrEqual(2);
  } finally {
    store.close();
    vi.restoreAllMocks();
  }
});

/** An empty read model for one task, as the server would answer for a clean one. */
function emptyChanges(taskId: string): TaskChanges {
  return {
    taskId,
    base: { commit: null, label: "HEAD", fallback: null },
    files: [],
    additions: 0,
    deletions: 0,
    truncated: false,
    error: null,
  };
}

test("a refresh answer replaces only its own task, and the diff call reaches the source", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const state = new Store<ConnectionState>({ status: "connected" });
  let asked: { id: string } | undefined;
  const source: ChangesSource = {
    state,
    watch: async () =>
      (async function* () {
        yield [emptyChanges("a"), emptyChanges("b")] as readonly TaskChanges[];
      })(),
    files: async (input) => {
      asked = input;
      return {
        ...emptyChanges(input.id),
        files: [
          {
            path: "x.txt",
            oldPath: null,
            status: "A",
            additions: 1,
            deletions: 0,
            binary: false,
            partial: false,
            note: null,
          },
        ],
        additions: 1,
      };
    },
    diff: async () => {
      const answer: ChangeDiff = {
        path: "x.txt",
        text: "diff --git a/x.txt b/x.txt\n",
        binary: false,
        size: 2,
        truncated: false,
        note: null,
      };
      return answer;
    },
  };
  const store = createChangesStore(source);
  try {
    await eventually(() => expect(store.getSnapshot().byTask.size).toBe(2));
    await store.refresh("b");
    expect(asked).toEqual({ id: "b" });
    expect(store.getSnapshot().byTask.get("b")?.files).toHaveLength(1);
    // The watch's other task is untouched by the pull.
    expect(store.getSnapshot().byTask.get("a")?.files).toEqual([]);
    expect((await store.diff("b", "x.txt")).text).toContain("diff --git");
  } finally {
    store.close();
    vi.restoreAllMocks();
  }
});
