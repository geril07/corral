import { createCorralClient, type CorralClient } from "@corral/client/corral-client";
import { afterEach, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { serverUrl } from "./server-url.ts";

/** What the active terminal shows; see `screen-text-hook.ts`. */
export function screenText(): string {
  return window.corralScreenText?.() ?? "";
}

export const prefixThen = (key: string) => userEvent.keyboard(`{Alt>}a{/Alt}${key}`);
export const prefixShifted = (key: string) =>
  userEvent.keyboard(`{Alt>}a{/Alt}{Shift>}${key}{/Shift}`);

/**
 * Registers the cleanup after each test and returns a way to open clients on the one real server of the run, closed after the test. The server outlives tests,
 * so afterwards everything a test left on it is removed: tasks (with their worktrees and
 * terminals), loose terminals and projects.
 */
export function realServerClients() {
  const clients: CorralClient[] = [];

  afterEach(async () => {
    const cleaner = newClient();
    const { api } = cleaner.connection;
    await vi.waitFor(() => {
      if (!(cleaner.projects.getSnapshot().loaded && cleaner.tasks.getSnapshot().loaded))
        throw new Error("lists not loaded yet");
    });
    await Promise.all(
      cleaner.tasks
        .getSnapshot()
        .tasks.map((task) => api.tasks.remove({ id: task.id, force: true })),
    );
    await vi.waitFor(async () => {
      const listed = await api.terminals.list();
      await Promise.all(listed.map((terminal) => api.terminals.close({ id: terminal.id })));
      if (listed.length > 0) throw new Error("terminals were still open");
    });
    await Promise.all(
      cleaner.projects
        .getSnapshot()
        .projects.map((project) => api.projects.remove({ id: project.id })),
    );
    for (const client of clients.splice(0)) client.close();
  });

  function newClient(url = serverUrl(), createSocket?: (url: string) => WebSocket): CorralClient {
    const client = createCorralClient({
      serverUrl: url,
      backoff: { initialMs: 20, maxMs: 100 },
      ...(createSocket ? { createSocket } : {}),
    });
    clients.push(client);
    return client;
  }
  return { newClient };
}
