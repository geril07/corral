import type { ChatStoreSnapshot } from "@corral/client/chat-state";
import type { ChatStore } from "@corral/client/chat-store";
import type { CorralClient } from "@corral/client/corral-client";
import type { SessionsSnapshot } from "@corral/client/sessions-store";
import { Store } from "@corral/client/store";
import type { TasksSnapshot } from "@corral/client/tasks-store";
import type { ChatItem } from "@corral/protocol/chat";
import type { Session, Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { writeConfig } from "../../../test/config-command.ts";
import { realServerClients } from "../../../test/real-client.ts";
import { IDLE_CHAT } from "../../../test/recorded-chat.ts";
import { writeRepoFile } from "../../../test/repo-file-command.ts";
import { appWithProject } from "../../../test/task-flows.tsx";
import { ChatView } from "./chat-view.tsx";
import type { ChatFiles } from "./local-links.tsx";

const { newClient } = realServerClients();

/** A 1×1 PNG: enough for a real `<img>` to decode, small enough to keep a fixture readable. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const SESSION_ID = "chat-links";

function seededTask(projectId: string, workspacePath: string): Task {
  return {
    id: "task-links",
    projectId,
    title: "Local links",
    titleSource: "user",
    prompt: null,
    primarySessionId: SESSION_ID,
    branch: "main",
    workspacePath,
    ownsWorktree: false,
    state: "active",
    seenAt: null,
    createdAt: 1,
  };
}

function seededSession(taskId: string): Session {
  return {
    id: SESSION_ID,
    taskId,
    kind: "pi",
    view: "chat",
    agentSessionId: "pi-links",
    terminalId: null,
    state: "running",
    status: null,
    createdAt: 1,
  };
}

function assistant(text: string): ChatItem {
  return { kind: "assistant-message", id: "a1", text, streaming: false };
}

function chatStoreWith(items: readonly ChatItem[]): ChatStore {
  const state = new Store<ChatStoreSnapshot>({
    loaded: true,
    sequence: 0,
    state: IDLE_CHAT,
    items: [...items],
    failure: null,
  });
  return { subscribe: state.subscribe, getSnapshot: state.getSnapshot, close: () => {} };
}

/**
 * The app with one real task (created through the API, so `files.*` knows its workspace) and one
 * seeded chat session whose only item is the assistant text under test. Seeding the stores is how
 * the chat tab's own tests open a lane without a driver; `prepare` writes files before the lane
 * mounts, so the first resolution already sees them.
 */
async function laneWith(text: string, prepare?: (repo: string) => Promise<void>) {
  const real = newClient();
  const tasks = new Store<TasksSnapshot>({ loaded: true, tasks: [] });
  const sessions = new Store<SessionsSnapshot>({ loaded: true, sessions: [] });
  const chatStore = chatStoreWith([assistant(text)]);
  const client: CorralClient = {
    ...real,
    tasks: { subscribe: tasks.subscribe, getSnapshot: tasks.getSnapshot, close: () => {} },
    sessions: { subscribe: sessions.subscribe, getSnapshot: sessions.getSnapshot, close: () => {} },
    openChat: () => chatStore,
  };
  const { repo } = await appWithProject(client);
  const project = await vi.waitFor(() => {
    const found = real.projects.getSnapshot().projects.find((each) => each.path === repo);
    if (found === undefined) throw new Error("the project is not in the list yet");
    return found;
  });
  const created = await real.connection.api.tasks.create({
    projectId: project.id,
    title: "Local links",
    workspace: { type: "main-worktree" },
  });
  await prepare?.(repo);
  // The chat session is Corral's own record here, so it can carry the seeded id; its task is the
  // server's, so every `files.*` call resolves against a workspace the server knows.
  tasks.set({
    loaded: true,
    tasks: [{ ...seededTask(project.id, created.workspacePath), id: created.id }],
  });
  sessions.set({ loaded: true, sessions: [seededSession(created.id)] });
  await expect.element(page.getByRole("log", { name: "Chat transcript" })).toBeVisible();
  return { real, repo, task: created };
}

test("a resolved path is a link that opens the editor; an unresolved one stays text", async () => {
  await writeConfig(`[editor]\ncommand = "/bin/cat {file}"\n`);
  const { real, repo, task } = await laneWith(
    "Look at src/app.ts:3 and src/missing.ts, then done.",
    (root) => writeRepoFile(root, "src/app.ts", { text: "const answer = 42;\n" }),
  );

  const link = page.getByRole("link", { name: "src/app.ts:3" });
  await expect.element(link).toBeVisible();
  // `src/missing.ts` is not in the workspace, so resolution left it plain text (`docs/ux.md`).
  await expect.element(page.getByRole("link", { name: /missing/ })).not.toBeInTheDocument();

  await link.click();

  // The editor runs as a loose terminal in the task's workspace, with the resolved absolute path.
  const opened = await vi.waitFor(async () => {
    const listed = await real.connection.api.terminals.list();
    const terminal = listed.find((each) => each.command === "/bin/cat");
    if (terminal === undefined) throw new Error("the editor terminal is not open yet");
    return terminal;
  });
  expect(opened.args).toEqual([`${repo}/src/app.ts`]);
  expect(opened.cwd).toBe(task.workspacePath);
  expect(opened.taskId).toBeNull();
  expect(opened.sessionId).toBeNull();
  // Clicking also shows it: the lane gives way to the terminal that was opened.
  await expect.element(page.getByRole("log", { name: "Chat transcript" })).not.toBeInTheDocument();
});

test("an image previews inline and its lightbox is keyboard operable", async () => {
  await laneWith("Screenshot: shot.png", (repo) =>
    writeRepoFile(repo, "shot.png", { base64: PNG_BASE64 }),
  );

  const preview = page.getByRole("button", { name: "Preview shot.png" });
  await expect.element(preview).toBeVisible();
  await expect.element(page.getByRole("img", { name: "shot.png" })).toBeVisible();

  // The preview is a button, so a keyboard user opens the lightbox with Enter…
  preview.element().focus();
  await userEvent.keyboard("{Enter}");
  const lightbox = page.getByRole("dialog", { name: "shot.png" });
  await expect.element(lightbox).toBeVisible();
  // …and Escape closes it again.
  await userEvent.keyboard("{Escape}");
  await expect.element(lightbox).not.toBeInTheDocument();
});

test("a video previews inline as a video, with its lightbox", async () => {
  await laneWith("Recording: clip.mp4", (repo) =>
    // The element is what this test pins; a headless browser does not decode the frame.
    writeRepoFile(repo, "clip.mp4", { base64: "AAAAHGZ0eXBpc29t" }),
  );

  await page.getByRole("button", { name: "Preview clip.mp4" }).click();
  const lightbox = page.getByRole("dialog", { name: "clip.mp4" });
  await expect.element(lightbox).toBeVisible();
  // Inline preview and lightbox: two `<video>` elements, the lightbox one with controls.
  await expect.poll(() => document.querySelectorAll("video").length).toBe(2);
  await userEvent.keyboard("{Escape}");
  await expect.element(lightbox).not.toBeInTheDocument();
});

test("a media file too large to preview is one row, not a broken image", async () => {
  const tooLarge = {
    requested: "shot.png",
    path: "shot.png",
    name: "shot.png",
    kind: "file" as const,
    size: 9_000_000,
    media: "image" as const,
    mime: "image/png",
    previewable: false,
  };
  const open = vi.fn<(path: string, line?: number, column?: number) => Promise<void>>(
    async () => undefined,
  );
  const files: ChatFiles = {
    resolve: async (paths) =>
      paths.includes("shot.png")
        ? [{ status: "ok", target: tooLarge }]
        : paths.map((requested) => ({ status: "missing" as const, requested })),
    read: async () => {
      throw new Error("a file past the preview bound is never read");
    },
    open,
  };
  await render(
    <div className="h-screen w-full">
      <ChatView
        store={chatStoreWith([assistant("Screenshot: shot.png")])}
        agent="pi"
        files={files}
        abortHint="alt+a ."
        onSend={async () => {}}
        onAbort={async () => {}}
        onRespond={async () => {}}
        onChangeModel={() => {}}
        onChangeReasoning={() => {}}
      />
    </div>,
  );

  await expect.element(page.getByText("Too large to preview · 8.6 MB")).toBeVisible();
  await expect.element(page.getByRole("img", { name: "shot.png" })).not.toBeInTheDocument();
  await page.getByRole("button", { name: "Open" }).click();
  await vi.waitFor(() => expect(open).toHaveBeenCalledWith("shot.png", undefined, undefined));
});

test("a web link goes to the desktop shell instead of loading in the app window", async () => {
  const opened = vi.fn<(url: string) => Promise<void>>(async () => undefined);
  const openTab = vi.spyOn(window, "open").mockReturnValue(null);
  // The preload bridge is what makes this the desktop app (`docs/design.md`, trust boundary).
  window.corral = { server: async () => null, openExternal: opened };
  try {
    await laneWith("Read https://example.com/docs for the details.");
    const before = window.location.href;

    const link = page.getByRole("link", { name: "https://example.com/docs" });
    await expect.element(link).toBeVisible();
    await link.click();

    await vi.waitFor(() => expect(opened).toHaveBeenCalledWith("https://example.com/docs"));
    // The shell is the only path in the desktop app: no browser tab, no navigation here.
    expect(openTab).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
  } finally {
    openTab.mockRestore();
    delete window.corral;
  }
});

test("in a browser a web link opens a new tab, and this window stays where it was", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  try {
    await laneWith("Read https://example.com/docs for the details.");
    const before = window.location.href;

    await page.getByRole("link", { name: "https://example.com/docs" }).click();

    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        "https://example.com/docs",
        "_blank",
        "noopener,noreferrer",
      ),
    );
    expect(window.location.href).toBe(before);
  } finally {
    open.mockRestore();
  }
});
