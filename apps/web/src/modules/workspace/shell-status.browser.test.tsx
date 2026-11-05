import type { ConfigSnapshot } from "@corral/client/config-store";
import type { ConnectionState } from "@corral/client/connection-state";
import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { realServerClients } from "../../../test/real-client.ts";
import { KeymapProvider } from "../keymap/index.ts";
import { ShellStatus, type ShellFailure, type ShellStatusProps } from "./shell-status.tsx";

const { newClient } = realServerClients();
const connected: ConnectionState = { status: "connected" };
const disconnected: ConnectionState = {
  status: "disconnected",
  attempt: 2,
  startedAt: Date.now(),
};

/** The shell status reads the config for its problems icon; this snapshot has no problems. */
async function configSnapshot(): Promise<ConfigSnapshot> {
  const client = newClient();
  await expect.poll(() => client.config.getSnapshot().loaded).toBe(true);
  return client.config.getSnapshot();
}

function Status({
  snapshot,
  placement,
  armed = false,
  connection = connected,
  failure,
  onOpenConnection,
}: {
  snapshot: ConfigSnapshot;
  placement: ShellStatusProps["placement"];
  armed?: boolean;
  connection?: ConnectionState;
  failure?: ShellFailure;
  onOpenConnection?: (opener: HTMLElement) => void;
}) {
  return (
    <KeymapProvider config={snapshot}>
      <ShellStatus
        placement={placement}
        connection={connection}
        armed={armed}
        prefix="alt+a"
        failure={failure}
        onDismissFailure={() => {}}
        onOpenConnection={onOpenConnection ?? (() => {})}
        onOpenConfigProblems={() => {}}
      />
    </KeymapProvider>
  );
}

const longFailure: ShellFailure = {
  tone: "error",
  message:
    "The agent could not start: the workspace is on a branch this profile cannot launch, and the agent's own environment did not name a usable executable, so nothing was started.",
};

test("a failed action is a kit alert and keeps its whole sentence in a tooltip", async () => {
  const snapshot = await configSnapshot();
  await render(<Status snapshot={snapshot} placement="strip" failure={longFailure} />);

  const alert = page.getByRole("alert");
  await expect.element(alert).toBeVisible();
  await expect.element(alert).toHaveAttribute("data-slot", "alert");
  await expect.element(alert).toMatchTextContent(/The agent could not start/);

  // The row keeps one line, so the clipped span carries the full sentence on its hint.
  const clipped = () => alert.element().querySelector<HTMLElement>("span[title]");
  await expect.poll(() => clipped()?.getAttribute("title")).toBe(longFailure.message);
  expect(clipped()!.scrollWidth).toBeGreaterThan(clipped()!.clientWidth);
  await userEvent.hover(clipped()!);
  await expect.element(page.getByRole("tooltip")).toMatchTextContent(longFailure.message);
});

test("a short failure keeps its dismiss beside the message", async () => {
  const snapshot = await configSnapshot();
  await render(
    <Status
      snapshot={snapshot}
      placement="strip"
      failure={{ tone: "error", message: "The agent could not start." }}
    />,
  );

  const message = page.getByRole("alert").getByText("The agent could not start.");
  const dismiss = page.getByRole("button", { name: "Dismiss status" });
  await expect.element(dismiss).toBeVisible();
  // A control at the far edge of the row reads as the surface's, not the message's.
  const gap =
    dismiss.element().getBoundingClientRect().left -
    message.element().getBoundingClientRect().right;
  expect(gap).toBeGreaterThanOrEqual(0);
  // The alert's own padding and the row's gap, not a spacer or the row's far edge.
  expect(gap).toBeLessThanOrEqual(16);
});

test("guidance stays a status and its dismiss sits beside the message", async () => {
  const snapshot = await configSnapshot();
  await render(
    <Status
      snapshot={snapshot}
      placement="strip"
      failure={{ tone: "notice", message: "Select a task to see its changes." }}
    />,
  );

  const notice = page.getByRole("status").filter({ hasText: "Select a task to see its changes." });
  await expect.element(notice).toBeVisible();
  await expect.element(page.getByRole("alert")).not.toBeInTheDocument();

  const dismiss = page.getByRole("button", { name: "Dismiss status" });
  await expect.element(dismiss).toBeVisible();
  expect(dismiss.element().previousElementSibling?.textContent).toBe(
    "Select a task to see its changes.",
  );
});

test("the strip keeps its row while the prefix arms", async () => {
  const snapshot = await configSnapshot();
  const screen = await render(<Status snapshot={snapshot} placement="strip" />);
  const surface = document.querySelector<HTMLElement>('[data-slot="shell-status"]')!;
  const height = surface.getBoundingClientRect().height;
  expect(height).toBeGreaterThan(0);
  await expect.element(page.getByRole("status", { name: "prefix mode" })).not.toBeInTheDocument();

  // Arming changes the row's contents only: the same surface keeps the same height.
  await screen.rerender(<Status snapshot={snapshot} placement="strip" armed />);
  await expect.element(page.getByRole("status", { name: "prefix mode" })).toBeVisible();
  expect(document.querySelector<HTMLElement>('[data-slot="shell-status"]')).toBe(surface);
  expect(surface.getBoundingClientRect().height).toBe(height);
});

test("the footer keeps one row: the badge replaces the disarmed chord", async () => {
  const snapshot = await configSnapshot();
  const screen = await render(<Status snapshot={snapshot} placement="footer" />);
  const surface = document.querySelector<HTMLElement>('[data-slot="shell-status"]')!;
  const height = surface.getBoundingClientRect().height;
  await expect.element(page.getByText("alt+a")).toBeVisible();

  await screen.rerender(<Status snapshot={snapshot} placement="footer" armed />);
  await expect.element(page.getByRole("status", { name: "prefix mode" })).toBeVisible();
  expect(document.querySelector('[data-slot="shell-status"] kbd')).toBeNull();
  expect(surface.getBoundingClientRect().height).toBe(height);
});

test("the footer status opens recovery from the button A2 introduced", async () => {
  const snapshot = await configSnapshot();
  const opened: HTMLElement[] = [];
  await render(
    <Status
      snapshot={snapshot}
      placement="footer"
      connection={disconnected}
      onOpenConnection={(opener) => opened.push(opener)}
    />,
  );

  const opener = page.getByRole("button", { name: /^connection:/ });
  await expect.element(opener).toBeVisible();
  // The sr-only live region announces the drop; the row itself is A2's `layout="status"` button.
  await expect
    .element(page.getByRole("status"))
    .toMatchTextContent("Cannot reach the server. Attempt 2.");
  await opener.click();
  expect(opened).toEqual([opener.element()]);
});
