import type { Session } from "@corral/protocol/rpc";
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

const pane = () => page.getByRole("region", { name: "stopped session" });

test("a stopped agent says it resumes, and Enter starts it, as the button has the focus", async () => {
  const onRestart = vi.fn<() => void>();
  await render(
    <StoppedSession session={session("stopped")} restartHint="alt+a r" onRestart={onRestart} />,
  );

  await expect.element(pane()).toMatchTextContent("claude · stopped");
  await expect.element(pane()).toMatchTextContent("resumes");
  await expect.element(pane()).toMatchTextContent("Enter, or alt+a r.");
  await expect.element(pane().getByRole("button", { name: "Restart" })).toHaveFocus();

  await userEvent.keyboard("{Enter}");
  expect(onRestart).toHaveBeenCalledOnce();
});

test("a failed start's pane heading says failed and names the error", async () => {
  await render(
    <StoppedSession
      session={{
        ...session("stopped"),
        status: { state: "error", updatedAt: 1, message: "claude did not answer" },
        launchError: "claude did not answer within 15 s",
      }}
      restartHint="alt+a r"
      onRestart={() => undefined}
    />,
  );

  await expect.element(pane()).toMatchTextContent("claude · failed");
  await expect.element(pane()).toMatchTextContent("resumes");
  await expect.element(pane().getByRole("button", { name: "Restart" })).toBeVisible();
  await expect
    .element(pane().getByRole("alert"))
    .toMatchTextContent("claude did not answer within 15 s");
});

test("an unresumable session says it will start a new conversation", async () => {
  await render(
    <StoppedSession
      session={session("unresumable", "codex")}
      restartHint="alt+a r"
      onRestart={() => undefined}
    />,
  );

  await expect.element(pane()).toMatchTextContent("codex · unresumable");
  await expect.element(pane()).toMatchTextContent("will start a new conversation");
  await expect
    .element(pane().getByRole("button", { name: "Start a new conversation" }))
    .toHaveFocus();
});

test("a profiled session shows its snapshot profile, model and provider", async () => {
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
      restartHint="alt+a r"
      onRestart={() => undefined}
    />,
  );

  await expect.element(pane()).toMatchTextContent("Claude gateway · claude-sonnet-4-5");
});

test("a native-default launch shows no model from today's config", async () => {
  await render(
    <StoppedSession
      session={{ ...session("stopped"), launch: null }}
      restartHint="alt+a r"
      onRestart={() => undefined}
    />,
  );

  await expect.element(pane()).not.toMatchTextContent("claude-sonnet-4-5");
  await expect.element(pane()).toMatchTextContent("agent default model");
});

test("an old session says its launch choices are unknown, without guessing a model", async () => {
  await render(
    <StoppedSession
      session={{ ...session("stopped"), launch: undefined }}
      restartHint="alt+a r"
      onRestart={() => undefined}
    />,
  );

  await expect.element(pane()).toMatchTextContent("launch choices");
  await expect.element(pane()).toMatchTextContent("its model is unknown");
});

test("a safe launch error stays visible next to the restart button", async () => {
  await render(
    <StoppedSession
      session={{
        ...session("stopped"),
        launchError:
          "the server has no environment variable CLAUDE_TOKEN for profile claude-gateway",
      }}
      restartHint="alt+a r"
      onRestart={() => undefined}
    />,
  );

  await expect
    .element(pane().getByRole("alert"))
    .toMatchTextContent("no environment variable CLAUDE_TOKEN");
});
