import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { reportBody } from "../../../test/osc7501.ts";
import { prefixThen, realServerClients, screenText } from "../../../test/real-client.ts";
import { appWithProject, focusedIsTerminal, sessionTab } from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();

const card = (title: string) => page.getByRole("button", { name: new RegExp(title) });
const cardRoot = (title: string) => {
  const root = card(title).element().closest(".visual-task-card");
  if (!(root instanceof HTMLElement)) throw new Error(`no card for ${title}`);
  return root;
};
const cardStatus = (title: string) => {
  const status = cardRoot(title).querySelector(".visual-task-status");
  return status instanceof HTMLElement ? status : undefined;
};
const cardStatusText = (title: string) => cardStatus(title)?.textContent ?? "";
const claudeButton = () => sessionTab(/^claude/);

/** What the agent in the focused terminal is told to print: an OSC 7501 report. */
const report = (fields: Parameters<typeof reportBody>[0]) =>
  userEvent.keyboard(`osc ${reportBody(fields)}{Enter}`);

/** A task whose primary session is the fake Claude terminal, so its card follows that status. */
async function taskWithClaude(
  client: ReturnType<typeof newClient>,
  projectId: string,
  title: string,
) {
  await client.connection.api.tasks.create({
    projectId,
    title,
    prompt: title,
    agent: { kind: "claude", view: "terminal" },
    workspace: { type: "main-worktree" },
  });
  await card(title).click();
  await expect.poll(screenText).toContain("fake claude ready");
  // Selecting a card leaves the keyboard on it; the status report is typed into the terminal.
  await userEvent.click(page.getByRole("region", { name: "active terminal" }));
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
}

test("a blocked agent shows on its session and task card, and done updates both", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithClaude(client, project.id, "Alpha");

  await report({ state: "blocked", kind: "permission", msg: "Run rm -rf build?" });
  // The card and the selected session tab both name what needs attention.
  await expect.poll(() => cardStatusText("Alpha")).toContain("Blocked");
  expect(cardStatus("Alpha")?.getAttribute("data-tone")).toBe("blocked");
  await expect.element(claudeButton()).toHaveAccessibleName(/blocked/i);

  // A second task becomes current; Alpha's sessions stay with Alpha.
  await client.connection.api.tasks.create({
    projectId: project.id,
    title: "Beta",
    workspace: { type: "main-worktree" },
  });
  await card("Beta").click();
  await expect.element(claudeButton()).not.toBeInTheDocument();

  await card("Alpha").click();
  await expect.element(card("Alpha")).toHaveAttribute("aria-current", "true");
  await expect.element(claudeButton()).toHaveAttribute("aria-selected", "true");
  await userEvent.click(page.getByRole("region", { name: "active terminal" }));
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));

  await report({ state: "done", msg: "All green" });
  // The selected task is marked seen: the tab keeps the completion, while the card fades from
  // the unseen green Done to the neutral age. The unseen card is covered by its own test below.
  await expect.element(claudeButton()).toHaveAccessibleName(/done/i);
  await expect.poll(() => cardStatusText("Alpha")).not.toContain("Done");
  expect(cardStatus("Alpha")?.getAttribute("data-tone")).toBe("neutral");
});

test("stopping an agent drops the working status it had", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithClaude(client, project.id, "Alpha");
  await report({ state: "working" });
  await expect.poll(() => cardStatusText("Alpha")).toContain("Working");

  await prefixThen("x");
  await expect.element(sessionTab("claude stopped")).toBeVisible();
  await expect.poll(() => cardStatusText("Alpha")).not.toContain("Working");
});

/** The color a theme token resolves to, read through a throwaway element. */
function tokenColor(token: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}

test("working, needs you and done carry the three status colors, and idle stays muted", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithClaude(client, project.id, "Colored");

  await report({ state: "working" });
  await expect.poll(() => cardStatusText("Colored")).toContain("Working");
  expect(getComputedStyle(cardStatus("Colored")!).color).toBe(
    tokenColor("--visual-status-working"),
  );

  await report({ state: "blocked", kind: "question", msg: "Which branch?" });
  await expect.poll(() => cardStatusText("Colored")).toContain("Blocked");
  expect(getComputedStyle(cardStatus("Colored")!).color).toBe(
    tokenColor("--visual-status-blocked"),
  );

  await report({ state: "error", msg: "The agent stopped" });
  await expect.poll(() => cardStatusText("Colored")).toContain("Error");
  expect(getComputedStyle(cardStatus("Colored")!).color).toBe(tokenColor("--visual-status-error"));

  const session = client.sessions
    .getSnapshot()
    .sessions.find((candidate) => candidate.kind === "claude")!;
  await client.connection.api.tasks.create({
    projectId: project.id,
    title: "Another task",
    workspace: { type: "main-worktree" },
  });
  await card("Another task").click();
  // A completion is green while unseen; opening its task fades the same row to muted.
  const stream = client.attach(session.terminalId!, {
    write: () => undefined,
    reset: () => undefined,
    resize: () => undefined,
  });
  await vi.waitFor(() => expect(stream.state.getSnapshot().status).toBe("connected"));
  stream.input(`osc ${reportBody({ state: "done", msg: "All green" })}\n`);
  await expect.poll(() => cardStatusText("Colored")).toContain("Done");
  expect(getComputedStyle(cardStatus("Colored")!).color).toBe(tokenColor("--visual-status-done"));
  stream.close();
});

/**
 * The server-owned seen mark fades a completed card when its task is opened (`design.md`,
 * **Status**). The routed shell marks the selected task once per task/seenAt/status update.
 */
test("opening a task clears its unseen done mark", async () => {
  const { client, project } = await appWithProject(newClient());
  await taskWithClaude(client, project.id, "Seen");
  await client.connection.api.tasks.create({
    projectId: project.id,
    title: "Away",
    workspace: { type: "main-worktree" },
  });
  await card("Away").click();

  const session = client.sessions
    .getSnapshot()
    .sessions.find((candidate) => candidate.kind === "claude")!;
  const stream = client.attach(session.terminalId!, {
    write: () => undefined,
    reset: () => undefined,
    resize: () => undefined,
  });
  await vi.waitFor(() => expect(stream.state.getSnapshot().status).toBe("connected"));
  stream.input(`osc ${reportBody({ state: "done", msg: "All green" })}\n`);
  await expect.poll(() => cardStatusText("Seen")).toContain("Done");
  expect(getComputedStyle(cardStatus("Seen")!).color).toBe(tokenColor("--visual-status-done"));

  await card("Seen").click();
  await expect
    .poll(() => getComputedStyle(cardStatus("Seen")!).color)
    .toBe(tokenColor("--visual-text-faint"));
  stream.close();
});
