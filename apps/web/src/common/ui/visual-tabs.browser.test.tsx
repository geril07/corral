import { expect, test } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { useState, type CSSProperties } from "react";
import { render } from "vitest-browser-react";
import {
  VisualTabStrip,
  VisualWorkspaceGroups,
  type VisualTabDrop,
  type VisualTabItem,
} from "./visual-tabs.tsx";

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

function Harness({ count = 4, width = 400 }: { count?: number; width?: number }) {
  const [selected, setSelected] = useState("tab-1");
  return (
    <div style={{ width }}>
      <VisualTabStrip
        label="Sessions"
        items={items(count, selected)}
        onSelect={setSelected}
        onClose={() => undefined}
        add={
          <button type="button" aria-label="Add session">
            +
          </button>
        }
      />
    </div>
  );
}

/** The rendered boxes of a tab's close control and the end of the label's content area. */
function closeBoxes(tab: HTMLElement) {
  const main = tab.querySelector<HTMLElement>(".visual-tab-main")!;
  const close = tab.querySelector<HTMLElement>(".visual-tab-close")!;
  const mainBox = main.getBoundingClientRect();
  return {
    tab: tab.getBoundingClientRect(),
    close: close.getBoundingClientRect(),
    glyph: close.querySelector<SVGSVGElement>("svg")!.getBoundingClientRect(),
    contentRight: mainBox.right - Number.parseFloat(getComputedStyle(main).paddingRight),
  };
}

/** A 28 px tab, a 20 px control around a 14 px glyph with 3 px of inset, and a 4 px label gap. */
function expectCloseGeometry(tab: HTMLElement) {
  const box = closeBoxes(tab);
  expect(Math.round(box.tab.height)).toBe(28);
  expect(Math.round(box.close.width)).toBe(20);
  expect(Math.round(box.close.height)).toBe(20);
  expect(Math.round(box.glyph.width)).toBe(14);
  expect(Math.round(box.glyph.height)).toBe(14);
  expect(box.glyph.left - box.close.left).toBeGreaterThanOrEqual(3);
  expect(box.close.right - box.glyph.right).toBeGreaterThanOrEqual(3);
  expect(box.glyph.top - box.close.top).toBeGreaterThanOrEqual(3);
  expect(box.close.bottom - box.glyph.bottom).toBeGreaterThanOrEqual(3);
  expect(box.close.left - box.contentRight).toBeGreaterThanOrEqual(4);
}

test("the strip is a 40 px band with 28 px tabs and a 20 px close control on hover", async () => {
  const previousScale = document.documentElement.style.fontSize;
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
  expectCloseGeometry(tab);

  try {
    document.documentElement.style.fontSize = "140%";
    expectCloseGeometry(tab);
  } finally {
    document.documentElement.style.fontSize = previousScale;
    await unmount();
  }
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

test.for([1, 8, 20])(
  "the add control follows the last of %i tabs inside the scroller",
  async (count) => {
    const { container, unmount } = await render(<Harness count={count} />);
    const scroll = container.querySelector<HTMLElement>(".visual-tab-scroll")!;
    const tablist = container.querySelector<HTMLElement>('[role="tablist"]')!;
    const add = page.getByRole("button", { name: "Add session" }).element();
    const tabs = [...container.querySelectorAll<HTMLElement>(".visual-tab")];
    expect(tabs).toHaveLength(count);
    // The tablist holds exactly the tabs; the add control is its sibling inside the scroller.
    expect(tablist.querySelectorAll(".visual-tab")).toHaveLength(count);
    expect(tablist.querySelector('[aria-label="Add session"]')).toBeNull();
    expect(tablist.nextElementSibling?.contains(add)).toBe(true);
    expect(scroll.contains(add)).toBe(true);
    const gap = add.getBoundingClientRect().left - tabs.at(-1)!.getBoundingClientRect().right;
    expect(Math.round(gap)).toBeGreaterThanOrEqual(6);
    expect(Math.round(gap)).toBeLessThanOrEqual(8);
    await unmount();
  },
);

test("tabs shrink to their 72 px minimum before the strip scrolls", async () => {
  const natural = await render(<Harness count={8} width={1200} />);
  const naturalWidth = natural.container
    .querySelector<HTMLElement>(".visual-tab")!
    .getBoundingClientRect().width;
  await natural.unmount();

  // Wider than the eight 72 px minimums and their gaps, so they compress instead of scrolling.
  const compressed = await render(<Harness count={8} width={720} />);
  const compressedScroll = compressed.container.querySelector<HTMLElement>(".visual-tab-scroll")!;
  const compressedTabs = [...compressed.container.querySelectorAll<HTMLElement>(".visual-tab")];
  const compressedWidths = compressedTabs.map((tab) => tab.getBoundingClientRect().width);
  expect(compressedScroll.scrollWidth).toBe(compressedScroll.clientWidth);
  expect(compressedWidths.every((width) => width > 72)).toBe(true);
  expect(compressedWidths.every((width) => width < naturalWidth)).toBe(true);
  const compressedAdd = page.getByRole("button", { name: "Add session" }).element();
  expect(compressedAdd.getBoundingClientRect().left).toBeGreaterThanOrEqual(
    compressedTabs.at(-1)!.getBoundingClientRect().right,
  );
  await compressed.unmount();

  // Narrower than the minimums: every tab is 72 and only then does the strip scroll.
  const minimum = await render(<Harness count={8} width={500} />);
  const minimumScroll = minimum.container.querySelector<HTMLElement>(".visual-tab-scroll")!;
  const minimumTabs = [...minimum.container.querySelectorAll<HTMLElement>(".visual-tab")];
  expect(minimumTabs.every((tab) => Math.round(tab.getBoundingClientRect().width) === 72)).toBe(
    true,
  );
  expect(minimumScroll.scrollWidth).toBeGreaterThan(minimumScroll.clientWidth);
  await minimum.unmount();
});

test("the add control overflows with the strip and scrolls back into view", async () => {
  const { container, unmount } = await render(<Harness count={20} />);
  const scroll = container.querySelector<HTMLElement>(".visual-tab-scroll")!;
  const add = page.getByRole("button", { name: "Add session" }).element();
  expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);
  // The add control may scroll out, like a browser's tab-strip plus: it goes with the strip.
  expect(add.getBoundingClientRect().left).toBeGreaterThan(scroll.getBoundingClientRect().right);
  scroll.scrollLeft = scroll.scrollWidth;
  await expect
    .poll(() => {
      const box = add.getBoundingClientRect();
      const view = scroll.getBoundingClientRect();
      return box.left >= view.left && box.right <= view.right + 1;
    })
    .toBe(true);
  await unmount();
});

function CompanionHarness() {
  const [open, setOpen] = useState(true);
  const [width, setWidth] = useState(320);
  return (
    <div
      style={
        {
          width: 900,
          height: 400,
          display: "flex",
          "--workspace-gutter": "6px",
        } as CSSProperties
      }
    >
      <VisualWorkspaceGroups
        main={<div>main</div>}
        companion={
          <>
            <button type="button" onClick={() => setOpen(false)}>
              Shut the companion
            </button>
            <span data-testid="kept">kept</span>
          </>
        }
        mainVisible
        companionVisible={open}
        expanded={null}
        width={width}
        min={320}
        max={480}
        onResize={setWidth}
        onFocusGroup={() => undefined}
        onDrop={() => undefined}
      />
    </div>
  );
}

test("the companion keeps its contents mounted while it is shut, with an 8 px gap and a centred handle", async () => {
  const { container, unmount } = await render(<CompanionHarness />);
  const main = container.querySelector<HTMLElement>(
    ".visual-workspace-group:not(.visual-workspace-group-companion)",
  )!;
  const companion = container.querySelector<HTMLElement>(".visual-workspace-group-companion")!;
  const handle = page.getByRole("separator", { name: "Resize companion group" }).element();
  const gap = companion.getBoundingClientRect().left - main.getBoundingClientRect().right;
  expect(getComputedStyle(companion).borderLeftWidth).toBe("0px");
  expect(gap).toBe(8);
  expect(handle.getBoundingClientRect().width).toBe(8);
  expect(handle.getBoundingClientRect().left + 4).toBe(main.getBoundingClientRect().right + 4);
  expect(container.querySelector('[data-testid="kept"]')).not.toBeNull();

  Object.defineProperties(handle, {
    setPointerCapture: { configurable: true, value: () => undefined },
    releasePointerCapture: { configurable: true, value: () => undefined },
    hasPointerCapture: { configurable: true, value: () => true },
  });
  handle.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      clientX: 0,
    }),
  );
  handle.dispatchEvent(
    new PointerEvent("pointermove", {
      bubbles: true,
      pointerId: 1,
      clientX: -16,
    }),
  );
  await expect.element(handle).toHaveAttribute("aria-valuenow", "336");
  handle.dispatchEvent(
    new PointerEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      clientX: 0,
    }),
  );
  await userEvent.click(page.getByRole("button", { name: "Shut the companion" }));
  await expect.poll(() => getComputedStyle(companion).visibility).toBe("hidden");
  expect(companion.getBoundingClientRect().width).toBe(0);
  expect(container.querySelector('[data-testid="kept"]')).not.toBeNull();
  await unmount();
});

function PreviewHarness({
  side,
  width = 1000,
  onDrop,
}: {
  side: "right" | "left";
  width?: number;
  onDrop: (drop: VisualTabDrop) => void;
}) {
  const strip = (
    <VisualTabStrip
      label={side === "right" ? "Main tabs" : "Companion tabs"}
      items={items(3, "tab-1")}
      onSelect={() => undefined}
      onClose={() => undefined}
      dragGroup={side === "right" ? "main" : "companion"}
    />
  );
  return (
    <div
      style={
        {
          width,
          height: 600,
          display: "flex",
          "--workspace-gutter": "6px",
        } as CSSProperties
      }
    >
      <VisualWorkspaceGroups
        main={side === "right" ? strip : <div>main</div>}
        companion={side === "right" ? <div>companion</div> : strip}
        mainVisible={side === "right"}
        companionVisible={side === "left"}
        expanded={null}
        width={320}
        min={160}
        max={480}
        onResize={() => undefined}
        onFocusGroup={() => undefined}
        onDrop={onDrop}
      />
    </div>
  );
}

/** dnd-kit's PointerSensor: pointerdown on the tab, moves and the release on the document. */
async function dragToEdge(tab: Element, x: number, y: number) {
  for (const name of ["setPointerCapture", "releasePointerCapture", "hasPointerCapture"] as const) {
    Object.defineProperty(tab, name, { configurable: true, value: () => true });
  }
  const from = tab.getBoundingClientRect();
  const start = { x: from.left + from.width / 2, y: from.top + from.height / 2 };
  tab.dispatchEvent(
    new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: 1,
      ...start,
    }),
  );
  for (let step = 1; step <= 8; step += 1) {
    document.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        buttons: 1,
        clientX: start.x + ((x - start.x) * step) / 8,
        clientY: start.y + ((y - start.y) * step) / 8,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 24));
  }
}

function dragOver(container: HTMLElement) {
  return container.querySelector(".visual-tab-drop-edge[data-visible]") !== null;
}

test.for([
  { side: "right", width: 320 },
  { side: "left", width: 672 },
] as const)(
  "the split's drop zone is the body it will give that group on the $side edge",
  async ({ side, width }) => {
    const drops: VisualTabDrop[] = [];
    const { container, unmount } = await render(
      <PreviewHarness side={side} onDrop={(drop) => drops.push(drop)} />,
    );
    const groups = container.querySelector<HTMLElement>(".visual-workspace-groups")!;
    const edge = container.querySelector<HTMLElement>(".visual-tab-drop-edge")!;
    const box = groups.getBoundingClientRect();
    expect(getComputedStyle(edge).opacity).toBe("0");

    // Aim at the middle of the body, not at the edge of the window.
    await dragToEdge(
      page.getByRole("tab", { name: "session 2" }).element(),
      side === "right" ? box.right - width / 2 : box.left + width / 2,
      box.top + box.height / 2,
    );
    await expect.poll(() => dragOver(container)).toBe(true);

    // The zone is the box it paints: below the strip, the width the split gives the group.
    const area = edge.getBoundingClientRect();
    expect(area.width).toBe(width);
    expect(area.top).toBe(box.top);
    expect(area.bottom).toBe(box.bottom);
    // The group card's own corners: square where the strip would sit, 8 px at the bottom.
    expect(getComputedStyle(edge).borderTopLeftRadius).toBe("0px");
    expect(getComputedStyle(edge).borderBottomLeftRadius).toBe("8px");
    expect(getComputedStyle(edge).opacity).toBe("1");

    // A release anywhere inside it creates that group.
    document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
    await expect.poll(() => drops.length).toBe(1);
    expect(drops[0]?.group).toBe(side === "right" ? "companion" : "main");
    await unmount();
  },
);

test("a drop beside an expanded group covers the whole body", async () => {
  const drops: VisualTabDrop[] = [];
  const { container, unmount } = await render(
    <div
      style={
        {
          width: 1000,
          height: 600,
          display: "flex",
          "--workspace-gutter": "6px",
        } as CSSProperties
      }
    >
      <VisualWorkspaceGroups
        main={<div>main</div>}
        companion={
          <VisualTabStrip
            label="Companion tabs"
            items={items(3, "tab-1")}
            onSelect={() => undefined}
            onClose={() => undefined}
            dragGroup="companion"
          />
        }
        mainVisible={false}
        companionVisible
        expanded="companion"
        width={320}
        min={160}
        max={480}
        onResize={() => undefined}
        onFocusGroup={() => undefined}
        onDrop={(drop) => drops.push(drop)}
      />
    </div>,
  );
  const groups = container.querySelector<HTMLElement>(".visual-workspace-groups")!;
  const edge = container.querySelector<HTMLElement>(".visual-tab-drop-edge")!;
  const box = groups.getBoundingClientRect();
  await dragToEdge(
    page.getByRole("tab", { name: "session 2" }).element(),
    box.left + box.width / 2,
    box.top + box.height / 2,
  );
  await expect.poll(() => dragOver(container)).toBe(true);
  expect(edge.getBoundingClientRect().width).toBe(1000);
  document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  await expect.poll(() => drops.length).toBe(1);
  expect(drops[0]?.group).toBe("main");
  await unmount();
});

test("the strip row inside the column is a target, like the body", async () => {
  const drops: VisualTabDrop[] = [];
  const { container, unmount } = await render(
    <PreviewHarness side="right" onDrop={(drop) => drops.push(drop)} />,
  );
  const groups = container.querySelector<HTMLElement>(".visual-workspace-groups")!;
  const box = groups.getBoundingClientRect();
  // Inside the column, on the strip row, clear of every tab.
  await dragToEdge(
    page.getByRole("tab", { name: "session 1" }).element(),
    box.right - 40,
    box.top + 20,
  );
  await expect.poll(() => dragOver(container)).toBe(true);
  document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  await expect.poll(() => drops.length).toBe(1);
  expect(drops[0]?.group).toBe("companion");
  await unmount();
});

test("a tab inside the column still wins the drop, and the column keeps painting", async () => {
  const drops: VisualTabDrop[] = [];
  const { container, unmount } = await render(
    <PreviewHarness side="right" width={400} onDrop={(drop) => drops.push(drop)} />,
  );
  // A 400 px strip: the third tab sits inside the 320 px column.
  const target = page.getByRole("tab", { name: "session 3" }).element();
  const at = target.getBoundingClientRect();
  await dragToEdge(
    page.getByRole("tab", { name: "session 1" }).element(),
    at.left + at.width / 2,
    at.top + at.height / 2,
  );
  await expect.poll(() => dragOver(container)).toBe(true);
  document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
  await expect.poll(() => drops.length).toBe(1);
  expect(drops[0]).toMatchObject({ group: "main", over: "tab-3" });
  await unmount();
});
