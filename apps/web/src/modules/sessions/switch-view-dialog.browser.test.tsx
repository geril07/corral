import { ORPCError } from "@orpc/client";
import type { Session } from "@corral/protocol/rpc";
import { workspaceMissingMessage } from "@corral/protocol/workspace";
import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { SwitchViewDialog } from "./switch-view-dialog.tsx";

const session: Session = {
  id: "s1",
  taskId: "t1",
  kind: "claude",
  view: "chat",
  agentSessionId: null,
  terminalId: null,
  state: "stopped",
  status: null,
  createdAt: 0,
};

const dialog = () => page.getByRole("alertdialog");

const failed = (message: string) =>
  new ORPCError("LAUNCH_FAILED", { defined: true, data: { kind: "claude", message } });

for (const view of ["chat", "terminal"] as const) {
  for (const waiting of [false, true]) {
    test(`${view} handoff keeps the ${waiting ? "waiting" : "working"} consequence without the addendum`, async () => {
      await render(
        <SwitchViewDialog
          session={{ ...session, view }}
          target={view === "chat" ? "terminal" : "chat"}
          working={!waiting}
          waiting={waiting}
          onSwitch={() => Promise.resolve()}
          onClose={() => undefined}
        />,
      );
      const consequence = waiting
        ? view === "chat"
          ? "The agent is waiting for your answer. Switching cancels that request with the frontend."
          : "The agent is waiting for your answer. Switching closes its terminal and the request is lost."
        : view === "chat"
          ? "The agent is working. Switching aborts the turn first."
          : "The agent is working. Switching closes its terminal first; what it has not written is lost.";
      await expect.element(dialog()).toMatchTextContent(consequence);
      await expect
        .element(dialog())
        .not.toMatchTextContent("The conversation it already wrote stays");
      await expect.element(dialog().getByRole("button", { name: "Cancel" })).toBeVisible();
    });
  }
}

test("a handoff refused for a missing workspace names the sentence, not the wire code", async () => {
  const path = "/data/worktrees/repo/workspace-deleted-outside";
  await render(
    <SwitchViewDialog
      session={session}
      target="terminal"
      working
      waiting={false}
      onSwitch={() => Promise.reject(failed(workspaceMissingMessage(path)))}
      onClose={() => undefined}
    />,
  );

  await userEvent.click(dialog().getByRole("button", { name: "Switch to terminal" }));

  await expect
    .element(dialog().getByRole("alert"))
    .toMatchTextContent(workspaceMissingMessage(path));
  await expect.element(dialog()).not.toMatchTextContent("LAUNCH_FAILED");
});

test("another launch failure keeps its wrapped sentence in the dialog", async () => {
  await render(
    <SwitchViewDialog
      session={session}
      target="terminal"
      working
      waiting={false}
      onSwitch={() => Promise.reject(failed("spawn /usr/bin/claude EAGAIN"))}
      onClose={() => undefined}
    />,
  );

  await userEvent.click(dialog().getByRole("button", { name: "Switch to terminal" }));

  await expect
    .element(dialog().getByRole("alert"))
    .toMatchTextContent("The claude session could not be launched: spawn /usr/bin/claude EAGAIN.");
});
