import type { Session } from "@corral/protocol/rpc";
import { workspaceMissingMessage } from "@corral/protocol/workspace";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { StoppedSession } from "./stopped-session.tsx";

const session = (state: Session["state"], kind: Session["kind"] = "claude"): Session => ({
  id: "s1",
  taskId: "t1",
  kind,
  view: "terminal",
  agentSessionId: null,
  terminalId: null,
  state,
  status: null,
  createdAt: 0,
});

const pane = (badge: "stopped" | "failed" | "unresumable" = "stopped") =>
  page.getByRole("region", { name: `${badge} session` });

test("a stopped agent keeps its heading and focused Restart button, and Enter starts it", async () => {
  const onRestart = vi.fn<() => void>();
  await render(<StoppedSession session={session("stopped")} onRestart={onRestart} />);

  await expect.element(pane()).toMatchTextContent("claude · stopped");
  await expect.element(pane()).not.toMatchTextContent("resumes");
  await expect.element(pane()).not.toMatchTextContent("Enter, or");
  await expect.element(pane()).not.toMatchTextContent("alt+a r");
  await expect.element(pane().getByRole("button", { name: "Restart" })).toHaveFocus();

  await userEvent.keyboard("{Enter}");
  expect(onRestart).toHaveBeenCalledOnce();
  await pane().getByRole("button", { name: "Restart" }).click();
  expect(onRestart).toHaveBeenCalledTimes(2);
});

test("the pane speaks for the session only, never for the task's shelf state", async () => {
  await render(<StoppedSession session={session("stopped")} onRestart={() => undefined} />);

  await expect
    .element(pane())
    .not.toMatchTextContent("Starting it again resumes the agent's conversation.");
  // Settle is metadata: a stopped session has nothing to say about the task's shelf.
  await expect.element(pane()).not.toMatchTextContent("This task is settled.");
  await expect.element(pane()).not.toMatchTextContent("transcript");
  await expect.element(pane()).not.toMatchTextContent("history");
  await expect.element(pane()).not.toMatchTextContent("read");
  await expect.element(pane().getByRole("button", { name: "Restart" })).toHaveFocus();
});

test("a failed start's pane heading says failed and names the error", async () => {
  await render(
    <StoppedSession
      session={{
        ...session("stopped"),
        status: { state: "error", updatedAt: 1, message: "claude did not answer" },
        launchError: "claude did not answer within 15 s",
      }}
      onRestart={() => undefined}
    />,
  );

  await expect.element(pane("failed")).toMatchTextContent("claude · failed");
  await expect.element(pane("failed")).not.toMatchTextContent("resumes");
  await expect.element(pane("failed").getByRole("button", { name: "Restart" })).toBeVisible();
  await expect
    .element(pane("failed").getByRole("alert"))
    .toMatchTextContent("claude did not answer within 15 s");
});

test("a status-only error still names its reason in the pane", async () => {
  await render(
    <StoppedSession
      session={{
        ...session("stopped"),
        status: { state: "error", updatedAt: 1, message: "claude crashed" },
      }}
      onRestart={() => undefined}
    />,
  );

  await expect.element(pane("failed")).toMatchTextContent("claude · failed");
  await expect
    .element(pane("failed").getByRole("alert"))
    .toMatchTextContent("error: claude crashed");
});

test("an unresumable session keeps the new-conversation button without the note", async () => {
  await render(
    <StoppedSession session={session("unresumable", "codex")} onRestart={() => undefined} />,
  );

  await expect.element(pane("unresumable")).toMatchTextContent("codex · unresumable");
  await expect.element(pane("unresumable")).not.toMatchTextContent("will start a new conversation");
  await expect
    .element(pane("unresumable").getByRole("button", { name: "Start a new conversation" }))
    .toHaveFocus();
});

test("a profiled session has no launch line or tooltip", async () => {
  await render(
    <StoppedSession
      session={{
        ...session("stopped"),
        launch: {
          kind: "claude",
          profile: { id: "claude-gateway", name: "Claude gateway", revision: "0123456789ab" },
          model: "claude-sonnet-4-5",
          provider: null,
          env: [{ targetName: "ANTHROPIC_AUTH_TOKEN", fromEnv: "CLAUDE_TOKEN" }],
        },
      }}
      onRestart={() => undefined}
    />,
  );

  await expect.element(pane()).not.toMatchTextContent("Claude gateway");
  await expect.element(pane()).not.toMatchTextContent("claude-sonnet-4-5");
  await expect.element(pane().getByLabelText("launch choices")).not.toBeInTheDocument();
  await expect.element(pane().getByRole("tooltip")).not.toBeInTheDocument();
  await expect.element(pane().getByRole("button", { name: "Restart" })).toBeVisible();
});

test("a native-default launch shows no model from today's config", async () => {
  await render(
    <StoppedSession
      session={{ ...session("stopped"), launch: null }}
      onRestart={() => undefined}
    />,
  );

  await expect.element(pane()).not.toMatchTextContent("claude-sonnet-4-5");
  await expect.element(pane()).not.toMatchTextContent("agent default model");
  await expect.element(pane().getByRole("button", { name: "Restart" })).toBeVisible();
});

test("an old session keeps Restart without launch compatibility prose", async () => {
  await render(
    <StoppedSession
      session={{ ...session("stopped"), launch: undefined }}
      onRestart={() => undefined}
    />,
  );

  await expect.element(pane()).not.toMatchTextContent("launch choices");
  await expect.element(pane()).not.toMatchTextContent("its model is unknown");
  await expect.element(pane().getByRole("button", { name: "Restart" })).toBeVisible();
});

test("a safe launch error stays visible next to the restart button", async () => {
  await render(
    <StoppedSession
      session={{
        ...session("stopped"),
        launchError:
          "the server has no environment variable CLAUDE_TOKEN for profile claude-gateway",
      }}
      onRestart={() => undefined}
    />,
  );

  await expect
    .element(pane("failed").getByRole("alert"))
    .toMatchTextContent("no environment variable CLAUDE_TOKEN");
});

test("a workspace deleted outside Corral names the sentence and the path, never the OS line", async () => {
  const path = "/data/worktrees/repo/fix-login";
  await render(
    <StoppedSession
      session={{ ...session("stopped", "shell"), launchError: workspaceMissingMessage(path) }}
      onRestart={() => undefined}
    />,
  );

  const alert = pane("failed").getByRole("alert");
  await expect.element(alert).toMatchTextContent(workspaceMissingMessage(path));
  await expect.element(alert).toMatchTextContent(path);
  await expect.element(alert).not.toMatchTextContent("chdir");
  await expect.element(alert).not.toMatchTextContent("Process exited with code 1");
  await expect.element(pane("failed").getByRole("button", { name: "Restart" })).toBeVisible();
});
