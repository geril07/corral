import type { ConfigSnapshot } from "@corral/client/config-store";
import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { realServerClients } from "../../../test/real-client.ts";
import { KeymapProvider } from "../keymap/index.ts";
import { ShellStatus, type ShellFailure, type ShellStatusProps } from "./shell-status.tsx";

const { newClient } = realServerClients();
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
  failure,
}: {
  snapshot: ConfigSnapshot;
  placement: ShellStatusProps["placement"];
  armed?: boolean;
  failure?: ShellFailure;
}) {
  return (
    <KeymapProvider config={snapshot}>
      <ShellStatus
        placement={placement}
        armed={armed}
        prefix="alt+a"
        failure={failure}
        onDismissFailure={() => {}}
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

test("the strip exists only for a failure and grows for a wrapped one", async () => {
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
  expect(document.querySelector('[data-slot="shell-status"]')).toBeNull();

  await screen.rerender(
    <div className="w-58">
      <Status snapshot={snapshot} placement="strip" failure={failure} />
    </div>,
  );
  await expect.element(page.getByRole("status").filter({ hasText: "already gone" })).toBeVisible();
  const surface = document.querySelector<HTMLElement>('[data-slot="shell-status"]')!;
  expect(surface.getBoundingClientRect().height).toBeGreaterThan(0);

  await screen.rerender(
    <div className="w-58">
      <Status snapshot={snapshot} placement="strip" />
    </div>,
  );
  expect(document.querySelector('[data-slot="shell-status"]')).toBeNull();
});

test("the armed prefix floats without a row or a layout shift", async () => {
  const snapshot = await configSnapshot();
  const screen = await render(
    <div>
      <div data-testid="content" />
      <Status snapshot={snapshot} placement="strip" />
    </div>,
  );
  const content = page.getByTestId("content").element();
  const top = content.getBoundingClientRect().top;
  expect(document.querySelector('[data-slot="shell-status"]')).toBeNull();
  await expect.element(page.getByRole("status", { name: "prefix mode" })).not.toBeInTheDocument();

  await screen.rerender(
    <div>
      <div data-testid="content" />
      <Status snapshot={snapshot} placement="strip" armed />
    </div>,
  );
  await expect.element(page.getByRole("status", { name: "prefix mode" })).toBeVisible();
  const surface = document.querySelector<HTMLElement>('[data-slot="shell-status"]')!;
  expect(getComputedStyle(surface).position).toBe("absolute");
  expect(content.getBoundingClientRect().top).toBe(top);
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
