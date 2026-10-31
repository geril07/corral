import type { CorralClient } from "@corral/client/corral-client";
import type { TerminalSurface } from "@corral/client/terminal-stream";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { reportBody } from "../../../test/osc7501.ts";
import { prefixThen, realServerClients } from "../../../test/real-client.ts";
import { App } from "../../../test/render-app.tsx";
import { appWithProject, createTask, taskButton, workspace } from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();
const palette = () => page.getByRole("dialog", { name: "Command palette" });
const sectionHeading = (name: string) => workspace().getByRole("heading", { name });
const projectHeader = () => workspace().getByRole("button", { name: /^repo-/ });

/**
 * Reports a status from an agent session of the task the UI is not showing. A terminal the
 * main area does not display still belongs to the task, so its report arrives while the user is
 * looking at another task — which is exactly when a completion stays unseen.
 */
async function reportFromHiddenAgent(client: CorralClient, taskId: string, body: string) {
  const session = await client.connection.api.sessions.start({
    taskId,
    kind: "claude",
    size: { cols: 80, rows: 24 },
  });
  // The screen is not looked at; the stream only carries the agent's stdin.
  const surface: TerminalSurface = {
    write: () => undefined,
    reset: () => undefined,
    resize: () => undefined,
  };
  const stream = client.attach(session.terminalId!, surface);
  await vi.waitFor(() => expect(stream.state.getSnapshot().status).toBe("connected"));
  stream.input(`osc ${body}\n`);
}

test("prefix l switches flat and project modes, the device keeps the choice, and the palette lists it", async () => {
  const client = newClient();
  const { rendered } = await appWithProject(client);
  await createTask("Alpha");

  // Flat by status is the default: sections carry the list, not the project tree.
  await expect.element(sectionHeading("Done")).toBeVisible();
  await expect.element(projectHeader()).not.toBeInTheDocument();
  await expect.element(taskButton("Alpha")).toMatchTextContent(/repo-/);

  await prefixThen("l");
  await expect.element(projectHeader()).toBeVisible();
  await expect.element(sectionHeading("Done")).not.toBeInTheDocument();

  await prefixThen(" ");
  await expect
    .element(palette().getByRole("option", { name: /Toggle sidebar mode/ }))
    .toMatchTextContent("alt+a l");
  await userEvent.keyboard("{Escape}");

  // The preference is this device's: a fresh app on the same client opens in the mode it was left in.
  await rendered.unmount();
  await render(<App client={client} />);
  await expect.element(projectHeader()).toBeVisible();

  await prefixThen("l");
  await expect.element(sectionHeading("Done")).toBeVisible();
  await expect.element(projectHeader()).not.toBeInTheDocument();
});

test("a finished task stays marked until it is opened, and the mark is the server's seenAt", async () => {
  const { client } = await appWithProject(newClient());
  await createTask("Alpha");
  await createTask("Beta");
  const alpha = await vi.waitFor(() => {
    const found = client.tasks.getSnapshot().tasks.find((task) => task.title === "Alpha");
    if (!found) throw new Error("Alpha is not in the list yet");
    return found;
  });
  expect(alpha.seenAt).toBeNull();

  // Alpha finishes while Beta is selected, so its completion is unseen.
  await reportFromHiddenAgent(client, alpha.id, reportBody({ state: "done", msg: "All green" }));
  await expect.element(workspace().getByRole("img", { name: "unseen" })).toBeVisible();
  await expect.element(taskButton("Beta")).toHaveAttribute("aria-current", "true");
  await expect.element(taskButton("Alpha")).not.toHaveAttribute("aria-current");

  // Opening it clears the mark; the server keeps the moment, so every client derives the same.
  await taskButton("Alpha").click();
  await expect.element(taskButton("Alpha")).toHaveAttribute("aria-current", "true");
  await expect.element(workspace().getByRole("img", { name: "unseen" })).not.toBeInTheDocument();
  const marked = await vi.waitFor(() => {
    const found = client.tasks.getSnapshot().tasks.find((task) => task.id === alpha.id);
    if (found?.seenAt == null) throw new Error("the task is not marked seen yet");
    return found;
  });
  expect(marked.seenAt).toBeGreaterThanOrEqual(alpha.createdAt);

  // A second client reads the same time from the server, not from this device's storage.
  const other = newClient();
  await vi.waitFor(() => {
    const found = other.tasks.getSnapshot().tasks.find((task) => task.id === alpha.id);
    if (found === undefined) throw new Error("the other client has no task yet");
    return expect(found.seenAt).toBe(marked.seenAt);
  });
});
