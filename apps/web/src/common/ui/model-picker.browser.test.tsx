import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { useRef, useState } from "react";
import { ModelPicker } from "./model-picker.tsx";

test("model shortcuts select the filtered results in displayed order", async () => {
  const onModel = vi.fn<(key: string) => void>();
  await render(
    <ModelPicker
      title="Models"
      instances={[{ key: "pi", kind: "pi", name: "Pi" }]}
      instance="pi"
      onInstance={() => {}}
      models={[
        { key: "one", name: "First" },
        { key: "two", name: "Target" },
      ]}
      onModel={onModel}
      onClose={() => {}}
    />,
  );
  const search = page.getByPlaceholder("Search models…");
  await search.fill("Target");
  await expect.element(page.getByText("Ctrl+1")).toBeVisible();
  await userEvent.keyboard("{Control>}1{/Control}");
  expect(onModel).toHaveBeenCalledExactlyOnceWith("two");
});

test("the centered modal focuses search and previews without choosing a model", async () => {
  const onModel = vi.fn<(key: string) => void>();
  const onModelLevel = vi.fn<(key: string, level: string) => void>();
  await render(
    <ModelPicker
      title="Choose model"
      instances={[{ key: "pi", kind: "pi", name: "Pi" }]}
      instance="pi"
      onInstance={() => {}}
      models={[
        { key: "a", name: "Alpha", provider: "OpenAI", current: true },
        { key: "b", name: "Beta", provider: "OpenAI", levels: ["High"] },
      ]}
      levels={["Low"]}
      onModel={onModel}
      onModelLevel={onModelLevel}
      onClose={() => {}}
    />,
  );
  const dialog = page.getByRole("dialog", { name: "Choose model" });
  await expect.element(dialog).toBeVisible();
  await expect.element(page.getByRole("combobox", { name: "Search models" })).toHaveFocus();
  const box = dialog.element().getBoundingClientRect();
  expect(Math.abs(box.left + box.width / 2 - window.innerWidth / 2)).toBeLessThan(2);
  expect(box.width).toBeGreaterThan(500);
  await page.getByRole("option", { name: "Beta · OpenAI" }).hover();
  await expect.element(page.getByRole("button", { name: "High" })).toBeVisible();
  expect(onModel).not.toHaveBeenCalled();
  expect(onModelLevel).not.toHaveBeenCalled();
  await userEvent.keyboard("{ArrowUp}{ArrowDown}");
  expect(onModelLevel).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "High" }).click();
  expect(onModelLevel).toHaveBeenCalledExactlyOnceWith("b", "High");
  expect(onModel).not.toHaveBeenCalled();
  expect(page.getByText("OpenAI", { exact: true }).elements()).toHaveLength(1);
});

test("the configured default is a marked row in the model column", async () => {
  await render(
    <ModelPicker
      title="Models"
      instances={[{ key: "pi", kind: "pi", name: "Pi" }]}
      instance="pi"
      onInstance={() => {}}
      models={[
        { key: "a", name: "Alpha", provider: "stub", default: true },
        { key: "b", name: "Beta", provider: "stub" },
      ]}
      onModel={() => {}}
      onClose={() => {}}
    />,
  );
  await expect
    .element(page.getByRole("option", { name: "Alpha · stub · Default" }))
    .toMatchTextContent("Default");
  await expect.element(page.getByRole("option", { name: "Beta · stub" })).toBeVisible();
  expect(page.getByText("Default", { exact: true }).elements()).toHaveLength(1);
});

test("current model uses onLevel and another candidate stays disabled without atomic callback", async () => {
  const onLevel = vi.fn<(level: string) => void>();
  await render(
    <ModelPicker
      title="Models"
      instances={[{ key: "pi", kind: "pi", name: "Pi" }]}
      instance="pi"
      onInstance={() => {}}
      models={[
        { key: "a", name: "Alpha", current: true },
        { key: "b", name: "Beta", levels: ["High"] },
      ]}
      levels={["Low"]}
      onLevel={onLevel}
      onModel={() => {}}
      onClose={() => {}}
    />,
  );
  await page.getByRole("button", { name: "Low" }).click();
  expect(onLevel).toHaveBeenCalledExactlyOnceWith("Low");
  await page.getByRole("option", { name: "Beta" }).hover();
  await expect.element(page.getByRole("button", { name: "High" })).toBeDisabled();
  expect(onLevel).toHaveBeenCalledTimes(1);
});

test("choosing a reasoning level keeps the picker open and focuses the chosen level", async () => {
  const onLevel = vi.fn<(level: string) => void>();
  await render(
    <ModelPicker
      title="Models"
      instances={[{ key: "pi", kind: "pi", name: "Pi" }]}
      instance="pi"
      onInstance={() => {}}
      models={[{ key: "a", name: "Alpha", current: true }]}
      levels={["off", "medium", "high"]}
      level="medium"
      onLevel={onLevel}
      onModel={() => {}}
      onClose={() => {}}
    />,
  );
  await page.getByRole("button", { name: "high", exact: true }).click();
  expect(onLevel).toHaveBeenCalledExactlyOnceWith("high");
  await expect.element(page.getByRole("dialog", { name: "Models" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "high", exact: true })).toHaveFocus();
});

test("virtual model and instance lists navigate beyond mounted rows", async () => {
  const onModel = vi.fn<(key: string) => void>();
  const instances = Array.from({ length: 500 }, (_, i) => ({
    key: String(i),
    kind: "pi" as const,
    name: `Instance ${i}`,
  }));
  const models = Array.from({ length: 500 }, (_, i) => ({
    key: String(i),
    name: `Model ${i}`,
    provider: "Provider",
  }));
  function Fixture() {
    const [instance, setInstance] = useState("0");
    return (
      <ModelPicker
        title="Models"
        instances={instances}
        instance={instance}
        onInstance={setInstance}
        models={models}
        onModel={onModel}
        onClose={() => {}}
      />
    );
  }
  await render(<Fixture />);
  expect(page.getByRole("option").elements().length).toBeLessThan(100);
  const search = page.getByRole("combobox", { name: "Search models" });
  await userEvent.keyboard("{ArrowUp}");
  await expect.element(page.getByRole("option", { name: "Model 499 · Provider" })).toBeVisible();
  const modelId = search.element().getAttribute("aria-activedescendant");
  expect(document.getElementById(modelId ?? "")?.getAttribute("role")).toBe("option");
  const modelList = page.getByRole("listbox", { name: "Models" }).element();
  modelList.scrollTop = 0;
  modelList.dispatchEvent(new Event("scroll"));
  await expect.element(page.getByRole("option", { name: "Model 0 · Provider" })).toBeVisible();
  expect(document.getElementById(modelId ?? "")?.getAttribute("role")).toBe("option");
  await search.fill("Model 499");
  await userEvent.keyboard("{ArrowDown}{Enter}");
  expect(onModel).toHaveBeenCalledWith("499");
  await search.fill("");
  const rail = page.getByRole("radiogroup", { name: "Instances" });
  const first = page.getByRole("radio", { name: "Instance 0" });
  await expect.element(first).toBeChecked();
  first.element().focus();
  await userEvent.keyboard("{ArrowUp}");
  const last = page.getByRole("radio", { name: "Instance 499" });
  await expect.element(last).toBeVisible();
  await expect.element(last).toHaveAttribute("aria-checked", "true");
  // The keyboard follows the selection, so Space acts on the instance just chosen, not the old one.
  await expect.element(last).toHaveFocus();
  await userEvent.keyboard("Space");
  await expect.element(last).toHaveAttribute("aria-checked", "true");
  const scroller = rail.element().querySelector<HTMLElement>(".model-picker-rail-list");
  if (!scroller) throw new Error("Instance scroller missing");
  scroller.scrollTop = 0;
  scroller.dispatchEvent(new Event("scroll"));
  await expect.element(page.getByRole("radio", { name: "Instance 0" })).toBeVisible();
  await expect.element(last).toHaveAttribute("aria-checked", "true");
  // The selected instance is always rendered, so scrolling away cannot drop its focus.
  await expect.element(last).toHaveFocus();
});

function FocusFixture() {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={anchor} onClick={() => setOpen(true)}>
        Open picker
      </button>
      {open && (
        <ModelPicker
          title="Models"
          anchor={anchor}
          restoreFocus="anchor"
          instances={[{ key: "pi", kind: "pi", name: "Pi" }]}
          instance="pi"
          onInstance={() => {}}
          models={[]}
          onModel={() => {}}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

test("Escape closes the modal and restores its anchor", async () => {
  await render(<FocusFixture />);
  await page.getByRole("button", { name: "Open picker" }).click();
  await expect.element(page.getByRole("combobox", { name: "Search models" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("button", { name: "Open picker" })).toHaveFocus();
});

function GeometryFixture({
  busy = false,
  levelsPending = false,
}: {
  busy?: boolean;
  levelsPending?: boolean;
}) {
  const [instance, setInstance] = useState("one");
  const [level, setLevel] = useState("medium");
  const models =
    instance === "one"
      ? [
          { key: "alpha", name: "Alpha", provider: "stub", current: true },
          { key: "beta", name: "Beta", provider: "stub" },
        ]
      : [
          { key: "gamma", name: "Gamma", provider: "stub", current: true },
          { key: "delta", name: "Delta", provider: "stub" },
        ];
  return (
    <ModelPicker
      title="Models"
      instances={[
        { key: "one", kind: "pi", name: "Pi one" },
        { key: "two", kind: "claude", name: "Claude two" },
      ]}
      instance={instance}
      onInstance={setInstance}
      models={models}
      onModel={() => {}}
      levels={["off", "medium", "high"]}
      level={level}
      onLevel={setLevel}
      levelsPending={levelsPending}
      busy={busy}
      onClose={() => {}}
    />
  );
}

function rectOf(element: Element) {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function geometry() {
  return {
    dialog: rectOf(page.getByRole("dialog", { name: "Models" }).element()),
    rail: rectOf(document.querySelector(".model-picker-rail")!),
    models: rectOf(document.querySelector(".model-picker-models")!),
    thinking: rectOf(document.querySelector(".model-picker-thinking")!),
  };
}

function expectSameGeometry(
  before: ReturnType<typeof geometry>,
  after: ReturnType<typeof geometry>,
) {
  for (const region of ["dialog", "rail", "models", "thinking"] as const) {
    expect(
      Math.abs(after[region].width - before[region].width),
      `${region}.width ${before[region].width} -> ${after[region].width}`,
    ).toBeLessThan(1);
    expect(Math.abs(after[region].height - before[region].height), `${region}.height`).toBeLessThan(
      1,
    );
    expect(Math.abs(after[region].left - before[region].left), `${region}.left`).toBeLessThan(1);
    expect(Math.abs(after[region].top - before[region].top), `${region}.top`).toBeLessThan(1);
  }
}

async function settledGeometry() {
  const dialog = page.getByRole("dialog", { name: "Models" }).element();
  await Promise.all(
    dialog
      .getAnimations({ subtree: true })
      .map((animation) => animation.finished.catch(() => undefined)),
  );
  return geometry();
}

test("the dialog and each column keep their geometry across typing, switches and loading", async () => {
  const screen = await render(<GeometryFixture />);
  const baseline = await settledGeometry();
  const search = page.getByRole("combobox", { name: "Search models" });

  await search.fill("Beta");
  expectSameGeometry(baseline, await settledGeometry());
  await search.fill("no such model");
  expectSameGeometry(baseline, await settledGeometry());
  await search.fill("");
  expectSameGeometry(baseline, await settledGeometry());

  await page.getByRole("radio", { name: "Claude two" }).click();
  expectSameGeometry(baseline, await settledGeometry());

  await page.getByRole("option", { name: /Gamma/ }).click();
  expectSameGeometry(baseline, await settledGeometry());

  await page.getByRole("button", { name: "high", exact: true }).click();
  expectSameGeometry(baseline, await settledGeometry());
  await expect.element(page.getByRole("button", { name: "high", exact: true })).toHaveFocus();

  await screen.rerender(<GeometryFixture busy />);
  expectSameGeometry(baseline, await settledGeometry());

  await screen.rerender(<GeometryFixture busy levelsPending />);
  expectSameGeometry(baseline, await settledGeometry());
});

test("unknown levels show skeleton rows and aria-busy, never the previous levels", async () => {
  await render(<GeometryFixture levelsPending />);
  const thinking = page.getByRole("group", { name: "Thinking levels" });
  await expect.element(thinking).toHaveAttribute("aria-busy", "true");
  expect(thinking.element().querySelectorAll(".model-picker-level-skeleton")).toHaveLength(3);
  await expect
    .element(page.getByRole("button", { name: "medium", exact: true }))
    .not.toBeInTheDocument();
  expect(page.getByRole("dialog", { name: "Models" }).element().querySelectorAll("p")).toHaveLength(
    0,
  );
});

test("loading, empty and unsupported states are not prose", async () => {
  const screen = await render(
    <ModelPicker
      title="Models"
      instances={[{ key: "pi", kind: "pi", name: "Pi" }]}
      instance="pi"
      onInstance={() => {}}
      models={[]}
      onModel={() => {}}
      onClose={() => {}}
    />,
  );
  const dialog = page.getByRole("dialog", { name: "Models" });
  expect(dialog.element().querySelectorAll("p")).toHaveLength(0);
  expect(document.querySelector(".model-picker-levels-empty")).not.toBeNull();
  await page.getByRole("combobox", { name: "Search models" }).fill("nothing");
  expect(dialog.element().querySelectorAll("p")).toHaveLength(0);

  await screen.rerender(
    <ModelPicker
      title="Models"
      instances={[{ key: "pi", kind: "pi", name: "Pi" }]}
      instance="pi"
      onInstance={() => {}}
      models={[{ key: "a", name: "Alpha" }]}
      onModel={() => {}}
      busy
      onClose={() => {}}
    />,
  );
  expect(dialog.element().querySelectorAll("p")).toHaveLength(0);
  expect(document.querySelector(".model-picker-body")?.getAttribute("aria-busy")).toBe("true");
});

test("the three columns remain within narrow and medium viewports", async () => {
  const original = { width: window.innerWidth, height: window.innerHeight };
  try {
    await render(
      <ModelPicker
        title="Models"
        instances={[{ key: "pi", kind: "pi", name: "Pi" }]}
        instance="pi"
        onInstance={() => {}}
        models={[{ key: "a", name: "Useful model name", current: true }]}
        levels={["High"]}
        onLevel={() => {}}
        onModel={() => {}}
        onClose={() => {}}
      />,
    );
    await assertPickerViewport(360);
    await assertPickerViewport(1024);
    expect(page.getByRole("dialog", { name: "Models" }).elements()).toHaveLength(1);
  } finally {
    await page.viewport(original.width, original.height);
  }
});

async function assertPickerViewport(width: number) {
  await page.viewport(width, 700);
  await vi.waitFor(() => {
    const box = page.getByRole("dialog", { name: "Models" }).element().getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(width);
  });
  const dialog = page.getByRole("dialog", { name: "Models" }).element().getBoundingClientRect();
  for (const element of [
    page.getByRole("radiogroup", { name: "Instances" }),
    page.getByRole("combobox", { name: "Search models" }),
    page.getByRole("button", { name: "High" }),
  ]) {
    const box = element.element().getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(dialog.left - 1);
    expect(box.right).toBeLessThanOrEqual(dialog.right + 1);
    expect(box.width).toBeGreaterThan(25);
  }
  expect(dialog.left).toBeGreaterThanOrEqual(0);
  expect(dialog.right).toBeLessThanOrEqual(width);
}

test("composition Enter does not choose a model", async () => {
  const onModel = vi.fn<(key: string) => void>();
  await render(
    <ModelPicker
      title="Models"
      instances={[{ key: "pi", kind: "pi", name: "Pi" }]}
      instance="pi"
      onInstance={() => {}}
      models={[{ key: "a", name: "Alpha" }]}
      onModel={onModel}
      onClose={() => {}}
    />,
  );
  const search = page.getByRole("combobox", { name: "Search models" });
  await expect.element(search).toHaveFocus();
  search.element().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  search.element().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await userEvent.keyboard("{Enter}");
  expect(onModel).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  expect(onModel).toHaveBeenCalledExactlyOnceWith("a");
});

test("busy picker does not apply choices or close", async () => {
  const onModel = vi.fn<(key: string) => void>();
  const onLevel = vi.fn<(level: string) => void>();
  const onClose = vi.fn<() => void>();
  await render(
    <ModelPicker
      title="Models"
      instances={[{ key: "pi", kind: "pi", name: "Pi" }]}
      instance="pi"
      onInstance={() => {}}
      models={[{ key: "a", name: "Alpha", current: true }]}
      onModel={onModel}
      levels={["High"]}
      onLevel={onLevel}
      busy
      onClose={onClose}
    />,
  );
  await userEvent.keyboard("{Control>}1{/Control}{Enter}{Escape}");
  expect(onModel).not.toHaveBeenCalled();
  expect(onLevel).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  await expect.element(page.getByRole("button", { name: "High" })).toBeDisabled();
  await expect.element(page.getByRole("dialog", { name: "Models" })).toBeVisible();
});

test("the instance rail names an instance on focus as well as hover", async () => {
  await render(
    <ModelPicker
      title="Models"
      instances={[
        { key: "native:pi", kind: "pi", name: "pi", detail: "Native defaults" },
        { key: "native:claude", kind: "claude", name: "claude", detail: "Native defaults" },
      ]}
      instance="native:pi"
      onInstance={() => {}}
      models={[{ key: "a", name: "Alpha", current: true }]}
      onModel={() => {}}
      onClose={() => {}}
    />,
  );
  const rail = page.getByRole("radiogroup", { name: "Instances" });
  rail.element().focus();
  await userEvent.keyboard("{Tab}");
  const checked = page.getByRole("radio", { name: "pi" });
  await expect.element(checked).toHaveFocus();
  // The name and its detail are a hint, so the focused instance explains itself without a pointer.
  await expect.element(page.getByRole("tooltip")).toHaveTextContent("pi · Native defaults");
  expect(checked.element().getAttribute("title")).toBeNull();
});

test("a favorite row keeps its star and instance identity in the scoped list", async () => {
  await render(
    <ModelPicker
      title="Models"
      instances={[
        { key: "native:pi", kind: "pi", name: "pi" },
        { key: "profile:gateway:3", kind: "claude", name: "Gateway", badge: "GA" },
      ]}
      instance="profile:gateway:3"
      onInstance={() => {}}
      models={[
        { key: "one", name: "Stub One", provider: "stub", current: true, favorite: true },
        { key: "two", name: "Stub Two", provider: "stub" },
      ]}
      onModel={() => {}}
      onClose={() => {}}
    />,
  );
  await expect
    .element(page.getByRole("option", { name: "Stub One · stub · Favorite" }))
    .toMatchTextContent("★");
  await expect.element(page.getByRole("radio", { name: "Gateway" })).toBeChecked();
  await expect.element(page.getByRole("radio", { name: "pi" })).not.toBeChecked();
  await expect.element(page.getByText("stub", { exact: true })).toHaveLength(1);
});

test("favorites from two providers head their own runs without sharing a row key", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await render(
      <ModelPicker
        title="Models"
        instances={[{ key: "pi", kind: "pi", name: "Pi" }]}
        instance="pi"
        onInstance={() => {}}
        // Favorites are ordered ahead of the provider groups, so each provider heads two runs.
        models={[
          { key: "alpha-favorite", name: "Alpha favorite", provider: "Alpha", favorite: true },
          { key: "bravo-favorite", name: "Bravo favorite", provider: "Bravo", favorite: true },
          { key: "alpha", name: "Alpha one", provider: "Alpha" },
          { key: "bravo", name: "Bravo one", provider: "Bravo" },
        ]}
        onModel={() => {}}
        onClose={() => {}}
      />,
    );
    await expect.element(page.getByRole("option", { name: /Alpha one/ })).toBeVisible();
    expect(page.getByText("Alpha", { exact: true }).elements()).toHaveLength(2);
    expect(page.getByText("Bravo", { exact: true }).elements()).toHaveLength(2);
    // The virtual list refuses a repeated key: it would make rows go missing or jump.
    expect(
      errors.mock.calls.filter(([message]) => String(message).includes("overlapping key")),
    ).toHaveLength(0);
  } finally {
    errors.mockRestore();
  }
});
