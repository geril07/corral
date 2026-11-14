import type { CorralClient } from "@corral/client/corral-client";
import type { Session, Task } from "@corral/protocol/rpc";
import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { writeFilesIn } from "../../../test/files-client.ts";
import { createGitRepo } from "../../../test/git-repo.ts";
import {
  prefixShifted,
  prefixThen,
  realServerClients,
  screenText,
} from "../../../test/real-client.ts";
import { renderApp } from "../../../test/render-app.tsx";

const { newClient } = realServerClients();
const SIZE = { cols: 80, rows: 24 };

const sessionTabs = () => page.getByRole("tablist", { name: "Sessions" });
const sessionTab = (name: string | RegExp) => sessionTabs().getByRole("tab", { name });
const companionTabs = () => page.getByRole("tablist", { name: "Companion tabs" });

interface Seeded {
  client: CorralClient;
  projectId: string;
  task: Task;
  primary: Session;
  shell: Session;
  href: string;
}

/** A task with its primary chat agent and one shell, made through the server's own calls. */
async function seed(): Promise<Seeded> {
  const client = newClient();
  await expect.poll(() => client.connection.state.getSnapshot().status).toBe("connected");
  const { api } = client.connection;
  const project = await api.projects.add({ path: await createGitRepo("repo") });
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Alpha",
    prompt: "Explain the build",
    agent: { kind: "pi", view: "chat" },
    workspace: { type: "main-worktree" },
  });
  const shell = await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });
  const primary = client.sessions
    .getSnapshot()
    .sessions.find((session) => session.id === task.primarySessionId);
  if (primary === undefined) throw new Error("the primary session was not created");
  return {
    client,
    projectId: project.id,
    task,
    primary,
    shell,
    href: `/?project=${project.id}&task=${task.id}`,
  };
}

async function open(seeded: Seeded) {
  return renderApp(newClient(), [seeded.href]);
}

test("a task opens with its primary agent first and a shell beside it, in one strip", async () => {
  const seeded = await seed();
  const screen = await open(seeded);

  await expect.element(sessionTabs()).toBeVisible();
  await expect.element(sessionTab(/^pi/)).toHaveAttribute("aria-selected", "true");
  await expect.element(page.getByRole("log", { name: "Chat transcript" })).toBeVisible();
  // The working area names its task above the strip.
  await expect.element(page.getByRole("heading", { name: "Alpha" })).toBeVisible();
  expect(screen.container.querySelector(".visual-main-eyebrow")?.textContent).toContain("repo");
  const names = sessionTabs()
    .getByRole("tab")
    .elements()
    .map((element) => element.textContent ?? "");
  expect(names[0]).toContain("pi");
  expect(names[1]).toContain("shell");
  // The primary session is a role: its tab has no close control.
  const primaryTab = sessionTab(/^pi/).element().closest(".visual-tab");
  expect(primaryTab?.querySelector('[aria-label="Close pi tab"]')).toBeNull();
  // The strip starts at the main surface's edge: the toggle anchor is collapsed while the
  // sidebar owns the visible toggle.
  const band = screen.container.querySelector<HTMLElement>(".visual-tab-band")!;
  const surface = screen.container.querySelector<HTMLElement>(".visual-shell-main")!;
  expect(
    Math.abs(band.getBoundingClientRect().left - surface.getBoundingClientRect().left),
  ).toBeLessThan(1);
  // The add control follows the last tab inside the scroller.
  const scroller = screen.container.querySelector<HTMLElement>(".visual-tab-scroll")!;
  const add = page.getByRole("button", { name: "Add session" }).element();
  const lastTab = sessionTabs().getByRole("tab").elements().at(-1)!;
  expect(scroller.contains(add)).toBe(true);
  expect(add.closest(".visual-tab-add")).not.toBeNull();
  expect(lastTab.getBoundingClientRect().right).toBeLessThanOrEqual(
    add.getBoundingClientRect().left,
  );
  // The tablist holds exactly the tabs, and never the add control.
  expect(sessionTabs().element().querySelector('[aria-label="Add session"]')).toBeNull();
  expect(sessionTabs().getByRole("tab").elements()).toHaveLength(2);
  await userEvent.hover(add);
  await expect
    .poll(() => document.querySelector('[role="tooltip"]')?.textContent ?? "")
    .toContain("alt+a c");
  await expect
    .poll(() => document.querySelector('[role="tooltip"]')?.textContent ?? "")
    .toContain("alt+a s");
});

test("a plain click on the add control starts a shell, and its chevron opens Agent…", async () => {
  const seeded = await seed();
  await open(seeded);
  await expect.element(sessionTab(/^shell/)).toBeVisible();
  const before = seeded.client.sessions.getSnapshot().sessions.length;

  // A plain click is the common action: one shell in this task's workspace, no menu.
  await page.getByRole("button", { name: "Add session" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Agent…" })).not.toBeInTheDocument();
  await expect.poll(() => sessionTabs().getByRole("tab").elements()).toHaveLength(3);
  await expect.element(sessionTab(/^shell 2/)).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => seeded.client.sessions.getSnapshot().sessions.length).toBe(before + 1);
  const started = seeded.client.sessions
    .getSnapshot()
    .sessions.find(
      (session) =>
        session.taskId === seeded.task.id &&
        session.id !== seeded.shell.id &&
        session.id !== seeded.primary.id,
    );
  expect(started).toMatchObject({ kind: "shell", state: "running" });

  // The adjacent control is the one menu; the tooltip still names both chords.
  const options = page.getByRole("button", { name: "New agent session" });
  await userEvent.hover(options);
  await expect
    .poll(() => document.querySelector('[role="tooltip"]')?.textContent ?? "")
    .toMatch(/alt\+a c.*alt\+a s/);
  await options.click();
  await expect.element(page.getByRole("menuitem", { name: "Agent…" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Shell" })).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menuitem", { name: "Agent…" })).not.toBeInTheDocument();
});

test("keyboard order reaches the add control after the last tab", async () => {
  const seeded = await seed();
  await open(seeded);
  const last = sessionTab(/^shell/);
  await userEvent.click(last);
  last.element().focus();
  await userEvent.keyboard("{Tab}");
  await expect.element(page.getByRole("button", { name: "Add session" })).toHaveFocus();
});

test("a task with no sessions shows the strip with only its actions, never a fake tab", async () => {
  const setup = newClient();
  await expect.poll(() => setup.connection.state.getSnapshot().status).toBe("connected");
  const { api } = setup.connection;
  const project = await api.projects.add({ path: await createGitRepo("empty") });
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Empty",
    workspace: { type: "main-worktree" },
  });

  const screen = await renderApp(newClient(), [`/?project=${project.id}&task=${task.id}`]);
  await expect.poll(() => screen.container.querySelector(".visual-tab-band") !== null).toBe(true);
  const band = screen.container.querySelector<HTMLElement>(".visual-tab-band")!;
  await expect.element(band).toBeVisible();
  expect(band.querySelectorAll('[role="tab"]')).toHaveLength(0);
  // With no tab to follow, the strip has no add control: the empty pane owns the one Add session
  // button and its full menu, so the task never shows two controls with the same name.
  expect(page.getByRole("button", { name: "Add session" }).elements()).toHaveLength(1);
  await expect
    .element(page.getByRole("button", { name: "New agent session" }))
    .not.toBeInTheDocument();
  await page.getByRole("button", { name: "Add session" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Shell" })).toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: "Agent…" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Shell" }).click();
  await expect.element(sessionTabs().getByRole("tab")).toHaveLength(1);
});

test("prefix v moves the one agent tab between chat and terminal and back", async () => {
  const seeded = await seed();
  await open(seeded);
  await expect.element(page.getByRole("log", { name: "Chat transcript" })).toBeVisible();
  const before = sessionTabs().getByRole("tab").elements().length;

  await prefixThen("v");
  // The fake pi can already be waiting for input when the shortcut reaches it.
  await expect
    .poll(
      () =>
        screenText().includes("fake pi") || document.querySelector('[role="alertdialog"]') !== null,
    )
    .toBe(true);
  if (document.querySelector('[role="alertdialog"]') !== null) {
    await page.getByRole("button", { name: "Switch to terminal" }).click();
  }
  await expect.poll(() => sessionTabs().getByRole("tab").elements().length).toBe(before);
  await expect.element(sessionTab(/^pi/)).toHaveAttribute("aria-selected", "true");
  await expect.element(page.getByRole("log", { name: "Chat transcript" })).not.toBeInTheDocument();
  await expect.poll(() => screenText()).toContain("fake pi");

  await prefixThen("v");
  await expect.element(page.getByRole("log", { name: "Chat transcript" })).toBeVisible();
  expect(sessionTabs().getByRole("tab").elements()).toHaveLength(before);
});

test("the session tab menu reaches Chat and Terminal without a second tab", async () => {
  const seeded = await seed();
  await open(seeded);
  await expect.element(sessionTab(/^pi/)).toBeVisible();
  await expect.element(page.getByRole("log", { name: "Chat transcript" })).toBeVisible();
  const before = sessionTabs().getByRole("tab").elements().length;

  await sessionTab(/^pi/).click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Session actions for pi" });
  await expect.element(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Switch to terminal" }).click();
  // A working turn asks first; the same pointer path then confirms in the dialog.
  await expect
    .poll(
      () =>
        screenText().includes("fake pi") || document.querySelector('[role="alertdialog"]') !== null,
    )
    .toBe(true);
  if (document.querySelector('[role="alertdialog"]') !== null) {
    await page.getByRole("button", { name: "Switch to terminal" }).click();
  }
  await expect.poll(() => screenText()).toContain("fake pi");
  await expect.element(page.getByRole("log", { name: "Chat transcript" })).not.toBeInTheDocument();
  expect(sessionTabs().getByRole("tab").elements()).toHaveLength(before);

  await sessionTab(/^pi/).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Switch to chat" }).click();
  await expect.element(page.getByRole("log", { name: "Chat transcript" })).toBeVisible();
  expect(sessionTabs().getByRole("tab").elements()).toHaveLength(before);
});

test("a non-active chat asks before its view switches", async () => {
  const seeded = await seed();
  await seeded.client.connection.api.sessions.start({
    taskId: seeded.task.id,
    kind: "pi",
    view: "chat",
    size: SIZE,
  });
  const screen = await open(seeded);
  await expect.poll(() => sessionTabs().getByRole("tab").elements().length).toBe(3);

  const second = sessionTabs().getByRole("tab").elements()[2]!;
  await userEvent.click(second, { button: "right" });
  await page.getByRole("menuitem", { name: "Switch to terminal" }).click();
  await expect.element(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
  await screen.unmount();
});

test("no Changes button, tab, panel, finish bar or pull-request badge is reachable", async () => {
  const setup = newClient();
  await expect.poll(() => setup.connection.state.getSnapshot().status).toBe("connected");
  const { api } = setup.connection;
  const project = await api.projects.add({ path: await createGitRepo("no-changes") });
  const task = await api.tasks.create({
    projectId: project.id,
    title: "Changed work",
    workspace: { type: "new-branch" },
  });
  await writeFilesIn(task.workspacePath, {
    "README.md": "changed\n",
    "src/new.ts": "export {};\n",
  });
  const session = await api.sessions.start({ taskId: task.id, kind: "shell", size: SIZE });

  await renderApp(newClient(), [`/?project=${project.id}&task=${task.id}`]);
  await expect.element(sessionTabs().getByRole("tab", { name: /^shell/ })).toBeVisible();
  // The workspace has changes to show, and the shell is the only view of them: no trailing
  // action, no tab, no finish controls and no request badge anywhere in the working area.
  await expect.element(page.getByRole("button", { name: "Changes" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("tab", { name: "Changes" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("group", { name: "Finish" })).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("listbox", { name: "Changed files" }))
    .not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: /PR #/ })).not.toBeInTheDocument();
  await expect.element(page.getByText("Stage all", { exact: true })).not.toBeInTheDocument();
  // The removed chord neither opens a companion group nor crashes the prefix.
  await prefixShifted("c");
  await expect.element(companionTabs()).not.toBeInTheDocument();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(sessionTab(/^shell/)).toHaveAttribute("aria-selected", "true");
  expect(
    setup.sessions
      .getSnapshot()
      .sessions.filter((each) => each.taskId === task.id)
      .map((each) => each.id),
  ).toEqual([session.id]);
});

test("closing a running shell tab stops its session, removes the view and keeps no history", async () => {
  const seeded = await seed();
  await open(seeded);
  await userEvent.click(sessionTab(/^shell/));
  await expect.element(sessionTab(/^shell/)).toHaveAttribute("aria-selected", "true");

  await userEvent.hover(sessionTab(/^shell/));
  await userEvent.click(page.getByRole("button", { name: "Close shell tab" }));

  await expect.element(sessionTab(/^shell/)).not.toBeInTheDocument();
  await expect
    .poll(
      () =>
        seeded.client.sessions
          .getSnapshot()
          .sessions.find((session) => session.id === seeded.shell.id)?.state,
    )
    .toBe("stopped");
  expect(
    seeded.client.sessions.getSnapshot().sessions.find((session) => session.id === seeded.shell.id)
      ?.terminalId,
  ).toBeNull();
  await expect
    .poll(() => document.activeElement?.getAttribute("data-tab-id"))
    .toBe(`session:${seeded.primary.id}`);

  // Closing is final: no closed-tab history is stored, and the removed chord does nothing.
  const stored: unknown = JSON.parse(
    window.localStorage.getItem(`corral.task-tabs.${seeded.task.id}`) ?? "{}",
  );
  expect(stored).not.toHaveProperty("closed");
  await prefixShifted("q");
  await expect.element(sessionTab(/^shell/)).not.toBeInTheDocument();
});

test("a non-primary tab menu has one close action, which ends its session", async () => {
  const seeded = await seed();
  await open(seeded);
  await userEvent.click(sessionTab(/^shell/), { button: "right" });
  const menu = page.getByRole("menu", { name: "Session actions for shell" });
  await expect.element(menu).toBeVisible();
  const items = menu
    .getByRole("menuitem")
    .elements()
    .map((element) => element.textContent ?? "");
  expect(items).toContain("Close tab");
  expect(items).toContain("Remove session…");
  expect(items.some((item) => item.startsWith("Stop"))).toBe(false);

  await menu.getByRole("menuitem", { name: "Close tab" }).click();
  await expect.element(sessionTab(/^shell/)).not.toBeInTheDocument();
  await expect
    .poll(
      () =>
        seeded.client.sessions
          .getSnapshot()
          .sessions.find((session) => session.id === seeded.shell.id)?.state,
    )
    .toBe("stopped");
});

test("closing a running chat tab stops its driver and leaves the task state alone", async () => {
  const seeded = await seed();
  const other = await seeded.client.connection.api.sessions.start({
    taskId: seeded.task.id,
    kind: "pi",
    view: "chat",
    size: SIZE,
  });
  await open(seeded);
  await expect.poll(() => sessionTabs().getByRole("tab").elements().length).toBe(3);

  const tab = sessionTabs().getByRole("tab").elements()[2]!;
  await userEvent.click(tab, { button: "right" });
  const menu = page.getByRole("menu", { name: /Session actions for pi/ });
  await expect.element(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Close tab" }).click();

  await expect.poll(() => sessionTabs().getByRole("tab").elements().length).toBe(2);
  await expect
    .poll(
      () =>
        seeded.client.sessions.getSnapshot().sessions.find((session) => session.id === other.id)
          ?.state,
    )
    .toBe("stopped");
  expect(
    seeded.client.sessions.getSnapshot().sessions.find((session) => session.id === other.id)
      ?.terminalId,
  ).toBeNull();
  const task = seeded.client.tasks.getSnapshot().tasks.find((entry) => entry.id === seeded.task.id);
  expect(task?.state).toBe("active");
});

test("closing a tab still applies to its task after switching tasks during the stop", async () => {
  const seeded = await seed();
  const beta = await seeded.client.connection.api.tasks.create({
    projectId: seeded.projectId,
    title: "Beta",
    prompt: "Beta work",
    agent: { kind: "pi", view: "chat" },
    workspace: { type: "main-worktree" },
  });
  await open(seeded);
  await userEvent.click(sessionTab(/^shell/));
  await expect.element(sessionTab(/^shell/)).toHaveAttribute("aria-selected", "true");
  await userEvent.click(sessionTab(/^shell/), { button: "right" });
  await expect.element(page.getByRole("menu", { name: "Session actions for shell" })).toBeVisible();

  // Both clicks run in one task: the close hands off to `sessions.stop`, and the switch happens
  // before that promise can resolve, so the post-stop layout write sees another task on screen.
  const close = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === "Close tab",
  );
  const betaRow = document.querySelector<HTMLElement>(`[data-task-id="${beta.id}"]`);
  if (close === undefined || betaRow === null) throw new Error("the close and the task row");
  close.click();
  betaRow.click();

  await expect.element(page.getByRole("heading", { name: "Beta" })).toBeVisible();
  await expect
    .poll(
      () =>
        seeded.client.sessions
          .getSnapshot()
          .sessions.find((session) => session.id === seeded.shell.id)?.state,
    )
    .toBe("stopped");
  // The close landed on the task that owned the tab, not on the one now on screen.
  await page.getByRole("button", { name: /Alpha/ }).click();
  await expect.element(page.getByRole("heading", { name: "Alpha" })).toBeVisible();
  await expect.element(sessionTab(/^shell/)).not.toBeInTheDocument();
  expect(sessionTabs().getByRole("tab").elements()).toHaveLength(1);
});

test("the focused group does not leak into another task", async () => {
  const seeded = await seed();
  await seeded.client.connection.api.tasks.create({
    projectId: seeded.projectId,
    title: "Beta",
    prompt: "Beta work",
    agent: { kind: "pi", view: "chat" },
    workspace: { type: "main-worktree" },
  });
  await open(seeded);
  await userEvent.click(sessionTab(/^shell/));
  await prefixShifted("o");
  await expect.element(companionTabs()).toBeVisible();

  await page.getByRole("button", { name: /Beta/ }).click();
  await expect.element(page.getByRole("heading", { name: "Beta" })).toBeVisible();
  await prefixThen("q");
  await expect
    .element(page.getByRole("alert"))
    .toMatchTextContent(
      "The primary session is not a closable view; remove it with Remove session.",
    );
});

test("a refused close or move says why in the working-area line", async () => {
  const seeded = await seed();
  await open(seeded);
  await userEvent.click(sessionTab(/^pi/));

  await prefixThen("q");
  await expect
    .element(page.getByRole("alert"))
    .toMatchTextContent(
      "The primary session is not a closable view; remove it with Remove session.",
    );
  await prefixShifted("o");
  await expect
    .element(page.getByRole("alert"))
    .toMatchTextContent("The primary session is not moved between groups.");

  await userEvent.click(sessionTab(/^shell/));
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
});

test("the layout stored for this task and device is restored on open", async () => {
  const seeded = await seed();
  // What the previous visit wrote: the primary in the main group, the shell moved beside it.
  window.localStorage.setItem(
    `corral.task-tabs.${seeded.task.id}`,
    JSON.stringify({
      version: 1,
      tabs: [
        { kind: "session", sessionId: seeded.primary.id, group: "main", order: 0 },
        { kind: "session", sessionId: seeded.shell.id, group: "companion", order: 0 },
      ],
      active: {
        main: `session:${seeded.primary.id}`,
        companion: `session:${seeded.shell.id}`,
      },
      companionOpen: true,
      closed: [],
      seenSessions: [seeded.primary.id, seeded.shell.id],
    }),
  );

  await open(seeded);
  await expect.element(companionTabs()).toBeVisible();
  await expect
    .element(companionTabs().getByRole("tab", { name: /^shell/ }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(sessionTab(/^pi/)).toHaveAttribute("aria-selected", "true");
  // A different task on this device still starts from its default layout.
  expect(window.localStorage.getItem("corral.task-tabs.other")).toBeNull();
});

test("a stored layout that still carries closed-tab history opens without it", async () => {
  const seeded = await seed();
  window.localStorage.setItem(
    `corral.task-tabs.${seeded.task.id}`,
    JSON.stringify({
      version: 1,
      tabs: [{ kind: "session", sessionId: seeded.primary.id, group: "main", order: 0 }],
      active: { main: `session:${seeded.primary.id}` },
      companionOpen: false,
      closed: [{ kind: "session", sessionId: seeded.shell.id, group: "main", order: 1 }],
      seenSessions: [seeded.primary.id, seeded.shell.id],
    }),
  );

  await open(seeded);
  await expect.element(sessionTab(/^pi/)).toBeVisible();
  // The old history is not read back into the strip, and no action can reopen it.
  await expect.element(sessionTab(/^shell/)).not.toBeInTheDocument();
  expect(sessionTabs().getByRole("tab").elements()).toHaveLength(1);
});

test("a stored layout that still carries a changes tab opens without it", async () => {
  const seeded = await seed();
  window.localStorage.setItem(
    `corral.task-tabs.${seeded.task.id}`,
    JSON.stringify({
      version: 1,
      tabs: [
        { kind: "session", sessionId: seeded.primary.id, group: "main", order: 0 },
        { kind: "changes", group: "companion", order: 0 },
      ],
      active: { main: `session:${seeded.primary.id}`, companion: "changes" },
      companionOpen: true,
      seenSessions: [seeded.primary.id, seeded.shell.id],
    }),
  );

  await open(seeded);
  await expect.element(sessionTab(/^pi/)).toBeVisible();
  await expect.element(sessionTab(/^pi/)).toHaveAttribute("aria-selected", "true");
  // The removed view is not read back, and the empty half it occupied stays shut.
  await expect.element(page.getByRole("tab", { name: "Changes" })).not.toBeInTheDocument();
  await expect.element(companionTabs()).not.toBeInTheDocument();
  expect(sessionTabs().getByRole("tab").elements()).toHaveLength(1);
});

test("number, step, focus and move keys reach both groups", async () => {
  const seeded = await seed();
  await open(seeded);

  await prefixThen("2");
  await expect.element(sessionTab(/^shell/)).toHaveAttribute("aria-selected", "true");
  await prefixThen("p");
  await expect.element(sessionTab(/^pi/)).toHaveAttribute("aria-selected", "true");
  await prefixThen("n");
  await expect.element(sessionTab(/^shell/)).toHaveAttribute("aria-selected", "true");

  await prefixShifted("o");
  await expect.element(companionTabs().getByRole("tab", { name: /^shell/ })).toBeVisible();
  await expect
    .element(companionTabs().getByRole("tab", { name: /^shell/ }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(sessionTab(/^pi/)).toHaveAttribute("aria-selected", "true");

  await prefixShifted("w");
  await expect
    .element(companionTabs().getByRole("tab", { name: /^shell/ }))
    .toHaveAttribute("aria-selected", "true");
  await prefixShifted("b");
  await expect.element(companionTabs()).not.toBeInTheDocument();

  // With the companion shut, the main group is still whole.
  await expect.element(sessionTab(/^pi/)).toHaveAttribute("aria-selected", "true");
});

test("the splitter stores the width the frame can show in both directions", async () => {
  // A narrow sidebar leaves room for a real range: 320..348 at 1024.
  window.localStorage.setItem("corral.visual-sidebar-width", "100");
  window.localStorage.setItem("corral.companion-width", "320");
  const seeded = await seed();
  await open(seeded);
  await userEvent.click(sessionTab(/^shell/));
  await prefixShifted("o");
  await expect.element(companionTabs()).toBeVisible();
  const handle = page.getByRole("separator", { name: "Resize companion group" });
  await expect.element(handle).toHaveAttribute("aria-valuenow", "320");
  const press = (key: string) =>
    handle
      .element()
      .dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  press("ArrowLeft");
  await expect.element(handle).toHaveAttribute("aria-valuenow", "336");
  await expect.poll(() => window.localStorage.getItem("corral.companion-width")).toBe("336");
  press("ArrowRight");
  await expect.element(handle).toHaveAttribute("aria-valuenow", "320");
  await expect.poll(() => window.localStorage.getItem("corral.companion-width")).toBe("320");
  window.localStorage.setItem("corral.visual-sidebar-width", "320");
});

test("a bottom strip replaces the chrome row instead of leaving an empty band", async () => {
  window.localStorage.setItem(
    "corral.appearance",
    JSON.stringify({ scale: 100, tabPosition: "bottom" }),
  );
  const seeded = await seed();
  const screen = await open(seeded);
  await expect.element(sessionTabs()).toBeVisible();
  expect(screen.container.querySelector(".visual-main-chrome")).toBeNull();
  expect(
    screen.container.querySelector<HTMLElement>(".visual-tab-band")?.getAttribute("data-position"),
  ).toBe("bottom");
  window.localStorage.removeItem("corral.appearance");
});

test("closing the last companion tab collapses it but leaves the main strip alone", async () => {
  const seeded = await seed();
  await open(seeded);
  await userEvent.click(sessionTab(/^shell/));
  await prefixShifted("o");
  await expect.element(companionTabs()).toBeVisible();
  const mainCount = sessionTabs().getByRole("tab").elements().length;

  const movedTab = companionTabs().getByRole("tab", { name: /^shell/ });
  await userEvent.hover(movedTab);
  await userEvent.click(
    movedTab.element().closest(".visual-tab")!.querySelector('[aria-label="Close shell tab"]')!,
  );
  await expect.element(companionTabs()).not.toBeInTheDocument();
  expect(sessionTabs().getByRole("tab").elements()).toHaveLength(mainCount);
});
