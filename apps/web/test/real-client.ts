import { createCorralClient, type CorralClient } from "@corral/client/corral-client";
import { defaultModelPolicy } from "@corral/protocol/models";
import type { CreateSocket } from "@corral/client/reconnecting-socket";
import { afterEach, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { writeConfig } from "./config-command.ts";
import { serverTarget } from "./server-url.ts";

/** What the active terminal shows; see `screen-text-hook.ts`. */
export function screenText(): string {
  return window.corralScreenText?.() ?? "";
}

export const prefixThen = (key: string) => userEvent.keyboard(`{Alt>}a{/Alt}${key}`);
export const prefixShifted = (key: string) =>
  userEvent.keyboard(`{Alt>}a{/Alt}{Shift>}${key}{/Shift}`);

/**
 * Registers the cleanup that runs after each test and returns `newClient`, which opens clients
 * on the one real server of the run (they are closed afterwards). The server outlives tests, so
 * the cleanup removes everything a test left on it: tasks (with their worktrees and terminals),
 * loose terminals and projects.
 */
export function realServerClients() {
  const clients: CorralClient[] = [];

  afterEach(async () => {
    await writeConfig(null);
    const cleaner = newClient();
    const { api } = cleaner.connection;
    await vi.waitFor(() => {
      if (
        !(
          cleaner.projects.getSnapshot().loaded &&
          cleaner.tasks.getSnapshot().loaded &&
          cleaner.modelPreferences.getSnapshot().loaded
        )
      )
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
    const defaults = defaultModelPolicy();
    await Promise.all(
      cleaner.modelPreferences
        .getSnapshot()
        .items.filter((item) => JSON.stringify(item.policy) !== JSON.stringify(defaults))
        .map((item) => api.models.save({ ...item, policy: defaults })),
    );
    for (const client of clients.splice(0)) client.close();
  });

  function newClient(target = serverTarget(), createSocket?: CreateSocket): CorralClient {
    const client = createCorralClient({
      server: target,
      backoff: { initialMs: 20, maxMs: 100 },
      ...(createSocket ? { createSocket } : {}),
    });
    clients.push(client);
    return client;
  }
  return { newClient };
}
