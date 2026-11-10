import { expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { useRef, useState } from "react";
import { ModelPicker } from "./model-picker.tsx";
import { TaskDialog } from "./task-dialog.tsx";

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
  rail.element().focus();
  await userEvent.keyboard("{ArrowUp}");
  const last = page.getByRole("radio", { name: "Instance 499" });
  await expect.element(last).toBeVisible();
  await expect.element(last).toHaveAttribute("aria-checked", "true");
  const scroller = rail.element().querySelector<HTMLElement>(".model-picker-rail-list");
  if (!scroller) throw new Error("Instance scroller missing");
  scroller.scrollTop = 0;
  scroller.dispatchEvent(new Event("scroll"));
  await expect.element(page.getByRole("radio", { name: "Instance 0" })).toBeVisible();
  await expect.element(last).toHaveAttribute("aria-checked", "true");
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

test("composition Enter does not choose a model or submit a native override", async () => {
  const onModel = vi.fn<(key: string) => void>();
  const onSubmit = vi.fn<() => void>();
  await render(
    <ModelPicker
      title="Models"
      instances={[{ key: "pi", kind: "pi", name: "Pi" }]}
      instance="pi"
      onInstance={() => {}}
      models={[{ key: "a", name: "Alpha" }]}
      onModel={onModel}
      nativeModel={{ value: "custom", placeholder: "Custom", onChange: () => {}, onSubmit }}
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
  const native = page.getByRole("textbox", { name: "Model override" });
  await native.click();
  native.element().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  native.element().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  await userEvent.keyboard("{Enter}");
  expect(onSubmit).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  expect(onSubmit).toHaveBeenCalledOnce();
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

function SuspendedFixture() {
  const [settings, setSettings] = useState(false);
  return (
    <>
      <ModelPicker
        title="Models"
        suspended={settings}
        instances={[{ key: "pi", kind: "pi", name: "Pi" }]}
        instance="pi"
        onInstance={() => {}}
        models={[{ key: "a", name: "Alpha" }]}
        onModel={() => {}}
        onClose={() => {}}
        footer={<button onClick={() => setSettings(true)}>Settings</button>}
      />
      {settings && (
        <TaskDialog title="Settings" onClose={() => setSettings(false)}>
          <button onClick={() => setSettings(false)}>Back</button>
        </TaskDialog>
      )}
    </>
  );
}

test("settings suspension retains search and restores search focus", async () => {
  await render(<SuspendedFixture />);
  await page.getByRole("combobox", { name: "Search models" }).fill("Alpha");
  await page.getByRole("button", { name: "Settings" }).click();
  await expect.element(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  expect(page.getByRole("dialog", { name: "Models" }).elements()).toHaveLength(0);
  await page.getByRole("button", { name: "Back" }).click();
  await expect.element(page.getByRole("combobox", { name: "Search models" })).toHaveFocus();
  await expect.element(page.getByRole("combobox", { name: "Search models" })).toHaveValue("Alpha");
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
