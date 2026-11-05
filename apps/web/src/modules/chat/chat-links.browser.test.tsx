import type { ChatStoreSnapshot } from "@corral/client/chat-state";
import type { ChatStore } from "@corral/client/chat-store";
import type { CorralClient } from "@corral/client/corral-client";
import type { SessionsSnapshot } from "@corral/client/sessions-store";
import { Store } from "@corral/client/store";
import type { TasksSnapshot } from "@corral/client/tasks-store";
import type { ChatItem } from "@corral/protocol/chat";
import type { FileResolution, Session, Task } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { writeConfig } from "../../../test/config-command.ts";
import { realServerClients } from "../../../test/real-client.ts";
import { IDLE_CHAT } from "../../../test/recorded-chat.ts";
import { writeRepoFile } from "../../../test/repo-file-command.ts";
import { appWithProject } from "../../../test/task-flows.tsx";
import { ChatViewHarness as ChatView } from "../../../test/chat-view-harness.tsx";
import type { ChatFiles } from "./local-links.tsx";

const { newClient } = realServerClients();

/** A one-frame VP8 WebM (548 bytes, 16×16): Chromium decodes it, so the `<video>` really loads. */
const WEBM_BASE64 =
  "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAH0EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1OsggHe7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDJXQYxMYXZmNjMuMS4xMDJEiYhAWQAAAAAAABZUrmvXrgEAAAAAAABO14EBc8WIytW+8ezQKLecgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QF9eEA4JCwgRC6gRCagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/pzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAyc3PVY8CLY8WIytW+8ezQKLdnyKBFo4dFTkNPREVSRIeTTGF2YzYzLjEuMTAyIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDAuMTAwMDAwMDAwAB9DtnWo54EAo6OBAACAEAIAnQEqEAAQAABHCIWFiIWEiAICAAwNYAD+/6tQgBxTu2uRu4+zgQC3iveBAfGCAbHwgQM=";

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
  return streamingChatStore(items).store;
}

/** The same store, with a way to push the next snapshot: a streamed message growing a delta at a time. */
function streamingChatStore(items: readonly ChatItem[]): {
  store: ChatStore;
  append: (delta: string) => void;
} {
  const state = new Store<ChatStoreSnapshot>({
    loaded: true,
    sequence: 0,
    state: IDLE_CHAT,
    items: [...items],
    failure: null,
  });
  return {
    store: { subscribe: state.subscribe, getSnapshot: state.getSnapshot, close: () => {} },
    append: (delta) => {
      const snapshot = state.getSnapshot();
      const last = snapshot.items.at(-1);
      if (last?.kind !== "assistant-message") return;
      state.set({
        ...snapshot,
        sequence: (snapshot.sequence ?? 0) + 1,
        items: [...snapshot.items.slice(0, -1), { ...last, text: last.text + delta }],
      });
    },
  };
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
    tasks: {
      subscribe: tasks.subscribe,
      getSnapshot: tasks.getSnapshot,
      failure: { subscribe: () => () => {}, getSnapshot: () => undefined },
      retry: () => {},
      close: () => {},
    },
    sessions: {
      subscribe: sessions.subscribe,
      getSnapshot: sessions.getSnapshot,
      failure: { subscribe: () => () => {}, getSnapshot: () => undefined },
      retry: () => {},
      close: () => {},
    },
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
  // Adding the project left its composer open over the URL's project; choosing the seeded task
  // is the navigation to its chat lane.
  await page
    .getByRole("navigation", { name: "workspace" })
    .getByRole("button", { name: /^Local links/ })
    .click();
  await expect.element(page.getByRole("log", { name: "Chat transcript" })).toBeVisible();
  return { real, repo, task: created };
}

test("a resolved path is a link that opens the editor; an unresolved one stays text", async () => {
  await writeConfig(`[editor]\ncommand = "/bin/cat {file}"\n`);
  const { real, repo, task } = await laneWith(
    "Look at src/app.ts:3 and src/missing.ts, then done.",
    (root) => writeRepoFile(root, "src/app.ts", { text: "const answer = 42;\n" }),
  );

  // A file link is an action, not a URL: a button, so no `href` can be copied or opened.
  const link = page.getByRole("button", { name: "src/app.ts:3" });
  await expect.element(link).toBeVisible();
  // `src/missing.ts` is not in the workspace, so resolution left it plain text (`docs/ux.md`).
  await expect.element(page.getByRole("button", { name: /missing/ })).not.toBeInTheDocument();

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

test("an explicit Markdown link to a workspace path opens the editor", async () => {
  await writeConfig(`[editor]\ncommand = "/bin/cat {file}"\n`);
  const { real, repo } = await laneWith("See [the file](src/app.ts:3) for it.", (root) =>
    writeRepoFile(root, "src/app.ts", { text: "const answer = 42;\n" }),
  );

  // The label is the agent's words; the destination is the path that opens the editor.
  const link = page.getByRole("button", { name: "the file" });
  await expect.element(link).toBeVisible();
  await link.click();

  const opened = await vi.waitFor(async () => {
    const listed = await real.connection.api.terminals.list();
    const terminal = listed.find((each) => each.command === "/bin/cat");
    if (terminal === undefined) throw new Error("the editor terminal is not open yet");
    return terminal;
  });
  expect(opened.args).toEqual([`${repo}/src/app.ts`]);
});

test("a destination outside the workspace is refused in place, whichever way it arrives", async () => {
  const openTab = vi.spyOn(window, "open").mockReturnValue(null);
  try {
    // The verifier's case: `[forbidden](/etc/passwd)` used to render as a plain anchor and open a
    // second tab on the static server. A reference link and a raw HTML anchor are the same hole.
    await laneWith(
      'Read [forbidden](/etc/passwd), [the reference][passwd], or <a href="/etc/passwd">raw</a>.\n\n[passwd]: /etc/passwd\n',
    );

    // The message rendered (its labels are there whatever the destinations become)…
    await expect.element(page.getByText(/forbidden/).first()).toBeVisible();
    // …and nothing in it is an anchor: the verifier's `[forbidden](/etc/passwd)` opened a tab from
    // one.
    expect(document.querySelectorAll("a")).toHaveLength(0);
    expect(document.querySelector('a[href*="passwd"]')).toBeNull();
    // In its place, one refusal per destination, once the lookup has answered.
    await expect.element(page.getByText(/outside the workspace/).first()).toBeVisible();
    expect(document.querySelectorAll('[role="note"]')).toHaveLength(3);

    const before = window.location.href;
    document
      .querySelector("article")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(window.location.href).toBe(before);
    expect(openTab).not.toHaveBeenCalled();
  } finally {
    openTab.mockRestore();
  }
});

test("an explicit link the lane does not own stays text and does not navigate", async () => {
  const openTab = vi.spyOn(window, "open").mockReturnValue(null);
  try {
    // A relative destination that is not a file of the workspace, and a `mailto:`: both are text.
    await laneWith("Read [handbook](docs/handbook) or [the mail](mailto:dev@example.com) first.");
    await expect.element(page.getByText(/handbook/)).toBeVisible();
    await expect.element(page.getByText(/the mail/)).toBeVisible();
    // Neither destination became a link or an action: the lane owns no URL for them.
    expect(
      [...document.querySelectorAll("a, button")].filter((element) =>
        ["handbook", "the mail"].some((name) => element.textContent === name),
      ),
    ).toEqual([]);
    // No anchor at all in this lane: neither destination reached the DOM.
    expect(document.querySelectorAll("a")).toHaveLength(0);

    const before = window.location.href;
    await page.getByRole("log", { name: "Chat transcript" }).click();
    expect(window.location.href).toBe(before);
    expect(openTab).not.toHaveBeenCalled();
  } finally {
    openTab.mockRestore();
  }
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
  await laneWith("Recording: clip.webm", (repo) =>
    writeRepoFile(repo, "clip.webm", { base64: WEBM_BASE64 }),
  );

  await page.getByRole("button", { name: "Preview clip.webm" }).click();
  const lightbox = page.getByRole("dialog", { name: "clip.webm" });
  await expect.element(lightbox).toBeVisible();
  // Inline preview and lightbox: two `<video>` elements, the lightbox one with controls.
  await expect.poll(() => document.querySelectorAll("video").length).toBe(2);
  await userEvent.keyboard("{Escape}");
  await expect.element(lightbox).not.toBeInTheDocument();
});

test("a video whose bytes do not decode is one row too", async () => {
  await laneWith("Recording: broken.webm", (repo) =>
    writeRepoFile(repo, "broken.webm", { text: "not a webm at all" }),
  );
  await expect
    .element(page.getByRole("button", { name: "Open broken.webm in the editor" }))
    .toBeVisible();
  await expect.element(page.getByText(/Preview unavailable/)).toBeVisible();
});

test("bytes that do not decode become one row with the editor, not a broken frame", async () => {
  await laneWith("Screenshot: broken.png", (root) =>
    // A `.png` name with text inside: the extension says image, the bytes do not decode.
    writeRepoFile(root, "broken.png", { text: "this is not a png" }),
  );

  const row = page.getByRole("button", { name: "Open broken.png in the editor" });
  await expect.element(row).toBeVisible();
  await expect.element(page.getByRole("img", { name: "broken.png" })).not.toBeInTheDocument();
  await expect.element(page.getByText(/Preview unavailable/)).toBeVisible();
});

test("a refused read becomes the same row, and the row's Open still reaches the editor", async () => {
  const open = vi.fn<(path: string, line?: number, column?: number) => Promise<void>>(
    async () => undefined,
  );
  const target = {
    requested: "shot.png",
    path: "shot.png",
    name: "shot.png",
    kind: "file" as const,
    size: 2048,
    media: "image" as const,
    mime: "image/png",
    previewable: true,
  };
  const files: ChatFiles = {
    resolve: async (paths) =>
      paths.map((requested) => ({ status: "ok" as const, target: { ...target, requested } })),
    read: async () => {
      throw new Error("the server refused the read");
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

  await expect.element(page.getByText(/Preview unavailable/)).toBeVisible();
  await page.getByRole("button", { name: "Open shot.png in the editor" }).click();
  await vi.waitFor(() => expect(open).toHaveBeenCalledWith("shot.png", undefined, undefined));
});

test("a streaming lane asks about each path once, and never retries a refused lookup", async () => {
  // A refused lookup is a transport problem, not a path that appeared again: one ask per path.
  const resolve = vi.fn<(paths: readonly string[]) => Promise<FileResolution[]>>(async () => {
    throw new Error("the server refused the lookup");
  });
  const files: ChatFiles = {
    resolve,
    read: async () => {
      throw new Error("no reads here");
    },
    open: async () => undefined,
  };
  const { store, append } = streamingChatStore([assistant("See src/app.ts")]);
  await render(
    <div className="h-screen w-full">
      <ChatView
        store={store}
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
  await expect.element(page.getByText("See src/app.ts")).toBeVisible();
  await vi.waitFor(() => expect(resolve.mock.calls.length).toBe(1));

  // Three deltas naming the same path: an in-flight or already-asked path is not asked again.
  append(" now");
  append(" please");
  append(", see src/app.ts again");
  await new Promise((done) => setTimeout(done, 200));
  expect(resolve.mock.calls.length).toBe(1);
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
  await page.getByRole("button", { name: "Open shot.png in the editor" }).click();
  await vi.waitFor(() => expect(open).toHaveBeenCalledWith("shot.png", undefined, undefined));
});

test("a server without files.* says so once and leaves the paths as text", async () => {
  // A daemon from before this slice on the same protocol answers oRPC's own "no procedure
  // matched" (§ `packages/client/src/rpc-errors.ts` `procedureMissing`, as C6's finish bar does).
  const { ORPCError } = await import("@orpc/client");
  const resolve = vi.fn<(paths: readonly string[]) => Promise<FileResolution[]>>(async () => {
    throw new ORPCError("NOT_FOUND", { message: "No procedure matched" });
  });
  const files: ChatFiles = {
    resolve,
    read: async () => {
      throw new Error("this server has no file bytes");
    },
    open: async () => undefined,
  };
  const { store, append } = streamingChatStore([assistant("See src/app.ts and src/b.ts")]);
  await render(
    <div className="h-screen w-full">
      <ChatView
        store={store}
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

  await expect.element(page.getByText(/does not offer file links/)).toBeVisible();
  // One muted line, however many paths the message names.
  expect(document.querySelectorAll('p[role="note"]')).toHaveLength(1);
  // The paths stay the text they already were: no link, no editor action.
  expect(document.querySelectorAll("a")).toHaveLength(0);
  await expect.element(page.getByText(/src\/app\.ts/)).toBeVisible();

  // A streaming delta with another path does not ask the old server again, and adds no line.
  const asked = resolve.mock.calls.length;
  append(" and src/c.ts too");
  await new Promise((done) => setTimeout(done, 200));
  expect(resolve.mock.calls.length).toBe(asked);
  expect(document.querySelectorAll('p[role="note"]')).toHaveLength(1);
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
