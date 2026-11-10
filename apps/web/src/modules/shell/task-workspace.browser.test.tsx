import type { CorralClient } from "@corral/client/corral-client";
import type { Session, Task } from "@corral/protocol/rpc";
import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
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
  await open(seeded);

  await expect.element(sessionTabs()).toBeVisible();
  await expect.element(sessionTab(/^pi/)).toHaveAttribute("aria-selected", "true");
  await expect.element(page.getByRole("log", { name: "Chat transcript" })).toBeVisible();
  const names = sessionTabs()
    .getByRole("tab")
    .elements()
    .map((element) => element.textContent ?? "");
  expect(names[0]).toContain("pi");
  expect(names[1]).toContain("shell");
  // The primary session is a role: its tab has no close control.
  const primaryTab = sessionTab(/^pi/).element().closest(".visual-tab");
  expect(primaryTab?.querySelector('[aria-label="Close tab"]')).toBeNull();
  // The trailing controls share the band and are not clipped by the reserved toggle slot.
  await expect.element(page.getByRole("button", { name: "Changes" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Add session" })).toBeVisible();
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

  await renderApp(newClient(), [`/?project=${project.id}&task=${task.id}`]);
  await expect.element(sessionTabs()).toBeVisible();
  expect(sessionTabs().getByRole("tab").elements()).toHaveLength(0);
  await expect.element(page.getByRole("button", { name: "Changes" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Add session" })).toBeVisible();
});

test("prefix v moves the one agent tab between chat and terminal and back", async () => {
  const seeded = await seed();
  await open(seeded);
  await expect.element(page.getByRole("log", { name: "Chat transcript" })).toBeVisible();
  const before = sessionTabs().getByRole("tab").elements().length;

  await prefixThen("v");
  await expect.poll(() => sessionTabs().getByRole("tab").elements().length).toBe(before);
  await expect.element(sessionTab(/^pi/)).toHaveAttribute("aria-selected", "true");
  await expect.element(page.getByRole("log", { name: "Chat transcript" })).not.toBeInTheDocument();
  await expect.poll(() => screenText()).toContain("fake pi");

  await prefixThen("v");
  await expect.element(page.getByRole("log", { name: "Chat transcript" })).toBeVisible();
  expect(sessionTabs().getByRole("tab").elements()).toHaveLength(before);
});

test("Changes opens in the companion group without moving the main session", async () => {
  const seeded = await seed();
  await open(seeded);
  await expect.element(sessionTab(/^pi/)).toHaveAttribute("aria-selected", "true");

  await prefixShifted("c");
  await expect.element(companionTabs()).toBeVisible();
  await expect
    .element(companionTabs().getByRole("tab", { name: "Changes" }))
    .toHaveAttribute("aria-selected", "true");
  await expect.element(sessionTab(/^pi/)).toHaveAttribute("aria-selected", "true");

  // The companion closes as a view; the main session did not move.
  await prefixThen("q");
  await expect.element(companionTabs()).not.toBeInTheDocument();
  await expect.element(sessionTab(/^pi/)).toHaveAttribute("aria-selected", "true");

  await prefixShifted("q");
  await expect.element(companionTabs()).toBeVisible();
  await expect
    .element(companionTabs().getByRole("tab", { name: "Changes" }))
    .toHaveAttribute("aria-selected", "true");
});

test("closing a session tab keeps the session, and reopen brings the view back", async () => {
  const seeded = await seed();
  await open(seeded);
  await userEvent.click(sessionTab(/^shell/));
  await expect.element(sessionTab(/^shell/)).toHaveAttribute("aria-selected", "true");

  await prefixThen("q");
  await expect.element(sessionTab(/^shell/)).not.toBeInTheDocument();
  expect(
    seeded.client.sessions.getSnapshot().sessions.some((session) => session.id === seeded.shell.id),
  ).toBe(true);

  await prefixShifted("q");
  await expect.element(sessionTab(/^shell/)).toBeVisible();
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

test("closing the last companion tab collapses it but leaves the main strip alone", async () => {
  const seeded = await seed();
  await open(seeded);
  await prefixShifted("c");
  await expect.element(companionTabs()).toBeVisible();
  const mainCount = sessionTabs().getByRole("tab").elements().length;

  const changesTab = companionTabs().getByRole("tab", { name: "Changes" });
  await userEvent.hover(changesTab);
  await userEvent.click(
    changesTab.element().closest(".visual-tab")!.querySelector('[aria-label="Close tab"]')!,
  );
  await expect.element(companionTabs()).not.toBeInTheDocument();
  expect(sessionTabs().getByRole("tab").elements()).toHaveLength(mainCount);
});
