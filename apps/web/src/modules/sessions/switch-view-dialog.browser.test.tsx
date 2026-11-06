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
