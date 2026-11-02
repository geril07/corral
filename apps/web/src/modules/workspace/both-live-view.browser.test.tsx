import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { prefixThen, realServerClients, screenText } from "../../../test/real-client.ts";
import {
  appWithProject,
  focusedIsTerminal,
  newTaskView,
  promptField,
  sessionTab,
} from "../../../test/task-flows.tsx";

const { newClient } = realServerClients();

const chatTranscript = () => page.getByRole("log", { name: "Chat transcript" });
const terminalHost = () => document.querySelector(".terminal-host");

/**
 * A `both-live` session keeps its PTY alive while chat is shown. `prefix v` must then render the
 * pane the session's view names — otherwise the live terminal wins forever — and it must work from
 * a focused terminal in both directions, which is how the verifier hit the bug.
 */
test("prefix v returns a both-live session from a focused terminal to chat, and back", async () => {
  const { client } = await appWithProject(newClient());
  await prefixThen("t");
  const form = newTaskView();
  await userEvent.click(form.getByRole("combobox", { name: /^Agent / }));
  await page.getByRole("option", { name: /^opencode/ }).click();
  await userEvent.click(form.getByRole("combobox", { name: /^View / }));
  await page.getByRole("option", { name: "chat" }).click();
  await userEvent.click(promptField());
  await userEvent.keyboard("both views{Enter}");

  // The task opens as chat on the fake OpenCode server Corral starts.
  await expect.element(chatTranscript()).toBeVisible();
  await expect.element(sessionTab(/^opencode/)).toHaveAttribute("aria-selected", "true");
  const session = await vi.waitFor(() => {
    const found = client.sessions.getSnapshot().sessions.find((each) => each.kind === "opencode");
    if (found === undefined) throw new Error("the session is not in the store yet");
    return found;
  });
  expect(session).toMatchObject({ view: "chat", terminalId: null });

  // Open the terminal: both frontends are live, and the terminal takes the keyboard.
  await prefixThen("v");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await expect.poll(() => screenText()).toContain("fake opencode ready");
  const opened = await vi.waitFor(() => {
    const found = client.sessions.getSnapshot().sessions.find((each) => each.id === session.id);
    if (found?.terminalId == null) throw new Error("the terminal is not attached yet");
    return found;
  });
  expect(opened.view).toBe("terminal");
  expect(opened.terminalId).not.toBeNull();

  // The return path, with the terminal focused: prefix v must show chat, not the still-live PTY.
  await prefixThen("v");
  await expect.element(chatTranscript()).toBeVisible();
  await vi.waitFor(() => expect(terminalHost()).toBeNull());
  await expect.element(sessionTab(/^opencode/)).toHaveAttribute("aria-selected", "true");
  await vi.waitFor(() => {
    const found = client.sessions.getSnapshot().sessions.find((each) => each.id === session.id);
    expect(found).toMatchObject({ view: "chat" });
  });
  // The server kept the terminal: the PTY was not killed by the return to chat.
  expect(
    client.sessions.getSnapshot().sessions.find((each) => each.id === session.id)?.terminalId,
  ).toBe(opened.terminalId);

  // And back to the terminal once more: the same live PTY is shown again.
  await prefixThen("v");
  await vi.waitFor(() => expect(focusedIsTerminal()).toBe(true));
  await expect.element(chatTranscript()).not.toBeInTheDocument();
  await vi.waitFor(() => expect(terminalHost()).not.toBeNull());
});
