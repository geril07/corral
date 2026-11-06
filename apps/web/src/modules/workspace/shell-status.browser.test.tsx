import type { ConfigSnapshot } from "@corral/client/config-store";
import type { ConnectionState } from "@corral/client/connection-state";
import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
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

test("a failed action is a kit alert whose whole sentence wraps instead of hiding in a tooltip", async () => {
  const snapshot = await configSnapshot();
  await render(
    <div className="w-58">
      <Status snapshot={snapshot} placement="strip" failure={longFailure} />
    </div>,
  );

  const alert = page.getByRole("alert");
  await expect.element(alert).toBeVisible();
  await expect.element(alert).toHaveAttribute("data-slot", "alert");
  await expect.element(alert).toMatchTextContent(/The agent could not start/);

  // The strip grows for a wrapped sentence; the last line is laid out inside the surface and the
  // full text is the alert's own, with no tooltip carrying the only copy.
  const element = alert.element();
  if (!(element instanceof HTMLElement)) throw new Error("the alert is not an HTML element");
  const surface = element.closest('[data-slot="shell-status"]')!.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(element);
  const lines = [...range.getClientRects()];
  expect(lines.length).toBeGreaterThan(1);
  expect(lines.at(-1)!.bottom).toBeLessThanOrEqual(surface.bottom + 1);
  expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
  expect(element.querySelector("span[title]")).toBeNull();
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

test.each([
  { width: 232, size: "w-58" },
  { width: 264, size: "w-66" },
])(
  "a long notice wraps inside the $width px footer, so its last fact is laid out, not clipped",
  async ({ size }) => {
    const snapshot = await configSnapshot();
    const noticeMessage =
      "The directory was already gone. The stale git entry was pruned; the branch workspace-deleted-outside remains.";
    await render(
      <div className={size}>
        <Status
          snapshot={snapshot}
          placement="footer"
          failure={{ tone: "notice", message: noticeMessage }}
        />
      </div>,
    );
    const notice = page.getByRole("status").filter({ hasText: "The directory was already gone." });
    await expect.element(notice).toBeVisible();
    const element = notice.element();
    if (!(element instanceof HTMLElement)) throw new Error("the notice is not an HTML element");
    const surface = element.closest('[data-slot="shell-status"]')!.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(element);
    const lines = [...range.getClientRects()];
    // Wrapped, not one truncated line with the fact only in a tooltip: the branch's last line is
    // inside the footer's box and the text has no horizontal overflow.
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.at(-1)!.bottom).toBeLessThanOrEqual(surface.bottom + 1);
    expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth + 1);
    expect(element.textContent).toContain("branch workspace-deleted-outside remains.");
  },
);

test("the strip grows for a wrapped failure and returns to its fixed row when it is dismissed", async () => {
  const snapshot = await configSnapshot();
  const failure: ShellFailure = {
    tone: "notice",
    message:
      "The directory was already gone. The stale git entry was pruned; the branch workspace-deleted-outside remains.",
  };
  const screen = await render(
    <div className="w-58">
      <Status snapshot={snapshot} placement="strip" />
    </div>,
  );
  const surface = document.querySelector<HTMLElement>('[data-slot="shell-status"]')!;
  const rowHeight = surface.getBoundingClientRect().height;
  expect(rowHeight).toBeGreaterThan(0);

  await screen.rerender(
    <div className="w-58">
      <Status snapshot={snapshot} placement="strip" failure={failure} />
    </div>,
  );
  await expect.element(page.getByRole("status").filter({ hasText: "already gone" })).toBeVisible();
  expect(surface.getBoundingClientRect().height).toBeGreaterThan(rowHeight);

  await screen.rerender(
    <div className="w-58">
      <Status snapshot={snapshot} placement="strip" />
    </div>,
  );
  await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  expect(surface.getBoundingClientRect().height).toBe(rowHeight);
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

test("the footer's disarmed hint yields while the connection is down and returns when it recovers", async () => {
  const snapshot = await configSnapshot();
  const screen = await render(
    <Status snapshot={snapshot} placement="footer" connection={disconnected} />,
  );
  const surface = document.querySelector<HTMLElement>('[data-slot="shell-status"]')!;
  const height = surface.getBoundingClientRect().height;
  await expect.element(page.getByRole("button", { name: /^connection:/ })).toBeVisible();
  // While the socket is down the state word owns the width the chord would have used.
  await expect.element(page.getByText("alt+a")).not.toBeInTheDocument();
  expect(surface.querySelector("kbd")).toBeNull();

  // The armed badge still replaces the hint, and the row still exists for it.
  await screen.rerender(
    <Status snapshot={snapshot} placement="footer" connection={disconnected} armed />,
  );
  await expect.element(page.getByRole("status", { name: "prefix mode" })).toBeVisible();
  expect(surface.querySelector("kbd")).toBeNull();
  expect(surface.getBoundingClientRect().height).toBe(height);

  // Recovered: the opener is gone and the disarmed hint returns in the same row.
  await screen.rerender(<Status snapshot={snapshot} placement="footer" />);
  await expect.element(page.getByRole("button", { name: /^connection:/ })).not.toBeInTheDocument();
  await expect.element(page.getByText("alt+a")).toBeVisible();
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
