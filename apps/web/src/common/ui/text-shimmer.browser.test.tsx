import { afterEach, expect, test, vi } from "vite-plus/test";
import { cdp, page, userEvent } from "vite-plus/test/browser";
import { useState } from "react";
import { render } from "vitest-browser-react";
import { TextShimmer } from "./text-shimmer.tsx";

/** Chromium's media emulation is the only way to change what a CSS media query sees. */
async function emulateMotion(reducedMotion: "no-preference" | "reduce") {
  await cdp().send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: reducedMotion }],
  });
}

afterEach(async () => {
  await emulateMotion("no-preference");
});

function part(slot: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-slot="${slot}"]`);
  if (element === null) throw new Error(`the shimmer has no ${slot}`);
  return element;
}

function Harness() {
  const [active, setActive] = useState(true);
  return (
    <div>
      <button type="button" onClick={() => setActive(false)}>
        Stop
      </button>
      <TextShimmer text="Working" active={active} />
    </div>
  );
}

test("the base layer carries the text and the moving copy is hidden from assistive technology", async () => {
  await render(<TextShimmer text="Working" active />);

  const root = document.querySelector('[data-component="text-shimmer"]');
  expect(root?.getAttribute("data-active")).toBe("true");
  expect(part("text-shimmer-base").textContent).toBe("Working");
  expect(part("text-shimmer-base").getAttribute("aria-hidden")).toBeNull();
  expect(part("text-shimmer-shimmer").getAttribute("aria-hidden")).toBe("true");
  expect(getComputedStyle(part("text-shimmer-sweep")).animationName).toBe("text-shimmer-window");
});

test("the copy fades out and its sweep stops when the work stops", async () => {
  await render(<Harness />);
  const root = document.querySelector('[data-component="text-shimmer"]');
  expect(root?.getAttribute("data-active")).toBe("true");
  expect(getComputedStyle(part("text-shimmer-sweep")).animationName).toBe("text-shimmer-window");

  await userEvent.click(page.getByRole("button", { name: "Stop" }));
  await vi.waitFor(() => expect(root?.getAttribute("data-active")).toBe("false"));
  expect(getComputedStyle(part("text-shimmer-sweep")).animationName).toBe("none");
  await vi.waitFor(() => expect(getComputedStyle(part("text-shimmer-shimmer")).opacity).toBe("0"));
  await vi.waitFor(() => expect(getComputedStyle(part("text-shimmer-base")).opacity).toBe("1"));
});

test("reduced motion keeps the active colour but runs no sweep", async () => {
  await emulateMotion("reduce");
  await render(<TextShimmer text="Working" active />);

  expect(getComputedStyle(part("text-shimmer-base")).opacity).toBe("0");
  expect(getComputedStyle(part("text-shimmer-shimmer")).opacity).toBe("1");
  expect(getComputedStyle(part("text-shimmer-sweep")).display).toBe("none");
  expect(getComputedStyle(part("text-shimmer-sweep")).animationName).toBe("none");
});

test("a long label truncates instead of widening its row", async () => {
  await render(
    <div style={{ width: 120 }}>
      <TextShimmer text="A label far too long for the row it sits in" active />
    </div>,
  );

  const root = document.querySelector<HTMLElement>('[data-component="text-shimmer"]');
  if (root === null) throw new Error("the shimmer did not mount");
  expect(root.getBoundingClientRect().width).toBeLessThanOrEqual(120);
  expect(part("text-shimmer-base").scrollWidth).toBeGreaterThan(
    part("text-shimmer-base").clientWidth,
  );
});
