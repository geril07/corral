import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { useState } from "react";
import { render } from "vitest-browser-react";
import { VisualCompanion, VisualTabStrip, type VisualTabItem } from "./visual-tabs.tsx";

function items(count: number, selected: string): VisualTabItem[] {
  return Array.from({ length: count }, (_unused, index) => {
    const id = `tab-${index + 1}`;
    return {
      id,
      kind: "session",
      label: `session ${index + 1}`,
      number: index + 1,
      selected: id === selected,
      canClose: index > 0,
      paneId: "pane",
    };
  });
}

function Harness({ count = 4 }: { count?: number }) {
  const [selected, setSelected] = useState("tab-1");
  return (
    <div style={{ width: 400 }}>
      <VisualTabStrip
        label="Sessions"
        items={items(count, selected)}
        onSelect={setSelected}
        onClose={() => undefined}
      />
    </div>
  );
}

test("the strip is a 40 px band with 28 px tabs and a 20 px close control on hover", async () => {
  const { container, unmount } = await render(<Harness />);
  const band = container.querySelector<HTMLElement>(".visual-tab-band")!;
  const tab = container.querySelectorAll<HTMLElement>(".visual-tab")[1]!;
  const main = tab.querySelector<HTMLElement>(".visual-tab-main")!;
  const close = tab.querySelector<HTMLElement>(".visual-tab-close")!;

  expect(band.getBoundingClientRect().height).toBe(40);
  expect(main.getBoundingClientRect().height).toBe(28);
  expect(getComputedStyle(main).borderRadius).toBe("6px");
  expect(close.getBoundingClientRect().width).toBe(20);
  expect(close.getBoundingClientRect().height).toBe(20);
  expect(Math.round(close.getBoundingClientRect().top - tab.getBoundingClientRect().top)).toBe(4);
  expect(getComputedStyle(close).opacity).toBe("0");

  await userEvent.hover(tab);
  await expect.poll(() => getComputedStyle(close).opacity).toBe("1");
  await unmount();
});

test("the strip scrolls with edge fades and keeps the selected tab in view", async () => {
  const { container, unmount } = await render(<Harness count={12} />);
  const scroll = container.querySelector<HTMLElement>(".visual-tab-scroll")!;
  expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);
  const endFade = container.querySelector<HTMLElement>('.visual-tab-fade[data-edge="end"]')!;
  await expect.poll(() => endFade.getAttribute("data-visible")).toBe("true");

  await userEvent.click(page.getByRole("tab", { name: /session 12/ }));
  await expect.poll(() => scroll.scrollLeft).toBeGreaterThan(0);
  const startFade = container.querySelector<HTMLElement>('.visual-tab-fade[data-edge="start"]')!;
  await expect.poll(() => startFade.getAttribute("data-visible")).toBe("true");
  await unmount();
});

function CompanionHarness() {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ width: 900, height: 400, display: "flex" }}>
      <VisualCompanion
        open={open}
        width={320}
        min={320}
        max={480}
        onResize={() => undefined}
        label="Resize companion group"
      >
        <button type="button" onClick={() => setOpen(false)}>
          Shut the companion
        </button>
        <span data-testid="kept">kept</span>
      </VisualCompanion>
    </div>
  );
}

test("the companion keeps its contents mounted while it is shut, with a 1 px split and 8 px hit area", async () => {
  const { container, unmount } = await render(<CompanionHarness />);
  const companion = container.querySelector<HTMLElement>(".visual-companion")!;
  const handle = page.getByRole("separator", { name: "Resize companion group" }).element();
  expect(getComputedStyle(companion).borderLeftWidth).toBe("1px");
  expect(handle.getBoundingClientRect().width).toBe(8);
  expect(container.querySelector('[data-testid="kept"]')).not.toBeNull();

  await userEvent.click(page.getByRole("button", { name: "Shut the companion" }));
  // A transparent 1 px border can survive the zero width; no pane is visible either way.
  await expect.poll(() => companion.getBoundingClientRect().width).toBeLessThanOrEqual(1);
  expect(container.querySelector('[data-testid="kept"]')).not.toBeNull();
  await unmount();
});
