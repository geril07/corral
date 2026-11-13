import type { ConnectionState } from "@corral/client/connection-state";
import { expect, test, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { ConnectionBanner } from "./connection-banner.tsx";

const banner = () => document.querySelector<HTMLElement>('[data-slot="connection-banner"]');
const disconnected: ConnectionState = {
  status: "disconnected",
  attempt: 3,
  startedAt: Date.now() - 2000,
};

/** The grace is a prop for tests; production keeps the T3 interval. */
function Banner({
  state,
  graceMs = 0,
  onOpenDetails = () => undefined,
  onRetry = () => undefined,
}: {
  state: ConnectionState;
  graceMs?: number;
  onOpenDetails?: (opener: HTMLElement) => void;
  onRetry?: () => void;
}) {
  return (
    <ConnectionBanner
      state={state}
      onOpenDetails={onOpenDetails}
      onRetry={onRetry}
      graceMs={graceMs}
    />
  );
}

test("a connected shell has no banner", async () => {
  await render(<Banner state={{ status: "connected" }} />);
  expect(banner()).toBeNull();
});

test("a transient outage names the server, its attempt and both actions", async () => {
  const opened: HTMLElement[] = [];
  const retry = vi.fn<() => void>();
  await render(
    <Banner state={disconnected} onOpenDetails={(opener) => opened.push(opener)} onRetry={retry} />,
  );

  await expect.element(page.getByText(/^Cannot reach the server · /)).toBeVisible();
  expect(banner()?.getAttribute("data-tone")).toBe("attention");
  await expect.element(page.getByText(/Attempt 3 · \d+ s/)).toBeVisible();
  // The live region carries the state once; the ticking elapsed time stays out of it.
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Cannot reach the server. Attempt 3.");

  await page.getByRole("button", { name: "Retry now" }).click();
  expect(retry).toHaveBeenCalledOnce();
  const details = page.getByRole("button", { name: "Details" });
  await details.click();
  expect(opened).toEqual([details.element()]);
});

test("a refused capability shows at once and offers the dialog, not a browser retry", async () => {
  await render(
    <Banner
      graceMs={60_000}
      state={{ status: "capability-refused", attempt: 2, startedAt: Date.now() }}
    />,
  );

  // A terminal state skips the grace: it cannot recover without a new capability.
  await expect.element(page.getByText(/^The server refused this capability · /)).toBeVisible();
  expect(banner()?.getAttribute("data-tone")).toBe("destructive");
  await expect.element(page.getByRole("button", { name: "Retry now" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Details" })).toBeVisible();
});

test("an unusable capability and a protocol mismatch name themselves", async () => {
  const invalid = await render(
    <Banner state={{ status: "invalid-capability", detail: "bad token" }} />,
  );
  await expect.element(page.getByText("That capability cannot be used")).toBeVisible();
  await invalid.unmount();

  await render(<Banner state={{ status: "protocol-mismatch", serverProtocolVersion: 12 }} />);
  await expect
    .element(page.getByText("This app and the server cannot talk to each other"))
    .toBeVisible();
  // The recovery dialog treats a mismatch as unreachable, so the banner keeps its retry.
  await expect.element(page.getByRole("button", { name: "Retry now" })).toBeVisible();
});

test("a stuck connect says what it is doing", async () => {
  await render(
    <Banner state={{ status: "connecting", attempt: 4, startedAt: Date.now() - 3000 }} />,
  );
  await expect.element(page.getByText(/^Connecting to the server · /)).toBeVisible();
  await expect.element(page.getByText(/Attempt 4 · \d+ s/)).toBeVisible();
  expect(banner()?.getAttribute("data-tone")).toBe("attention");
});

test("a reconnect waits for the grace and leaves as soon as the connection returns", async () => {
  const screen = await render(<Banner state={disconnected} graceMs={120} />);
  expect(banner()).toBeNull();

  await vi.waitFor(() => expect(banner()).not.toBeNull(), { timeout: 2000 });
  await expect.element(page.getByText(/^Cannot reach the server · /)).toBeVisible();

  await screen.rerender(<Banner state={{ status: "connected" }} graceMs={120} />);
  expect(banner()).toBeNull();
});
