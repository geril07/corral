import type { Session } from "@corral/protocol/rpc";
import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
// oxlint-disable-next-line import/no-unassigned-import -- stylesheet
import "./app.css";
import { StoppedSession } from "./StoppedSession.tsx";

const session = (state: Session["state"], kind: Session["kind"] = "claude"): Session => ({
  id: "s1",
  taskId: "t1",
  kind,
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
    <StoppedSession session={session("stopped")} prefix="alt+a" onRestart={onRestart} />,
  );

  await expect.element(pane()).toMatchTextContent("claude · stopped");
  await expect.element(pane()).toMatchTextContent("resumes");
  await expect.element(pane().getByRole("button", { name: "Start again" })).toHaveFocus();

  await userEvent.keyboard("{Enter}");
  expect(onRestart).toHaveBeenCalledOnce();
});

test("an unresumable session says it will start a new conversation", async () => {
  await render(
    <StoppedSession
      session={session("unresumable", "codex")}
      prefix="alt+a"
      onRestart={() => undefined}
    />,
  );

  await expect.element(pane()).toMatchTextContent("codex · unresumable");
  await expect.element(pane()).toMatchTextContent("will start a new conversation");
  await expect
    .element(pane().getByRole("button", { name: "Start a new conversation" }))
    .toHaveFocus();
});
