import { afterEach, expect, test, vi } from "vite-plus/test";
import {
  createAreaFocusController,
  isFocusArea,
  startShellFocus,
  type FocusArea,
} from "./index.ts";

const mounted: HTMLElement[] = [];
let dispose: (() => void) | undefined;

function area(name: FocusArea, ...controls: HTMLElement[]): HTMLElement {
  const root = document.createElement("div");
  root.setAttribute("data-focus-area", name);
  root.tabIndex = -1;
  root.style.cssText = "width: 200px; height: 80px;";
  root.append(...controls);
  document.body.append(root);
  mounted.push(root);
  return root;
}

function control(label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = label;
  button.setAttribute("aria-label", label);
  button.style.cssText = "width: 80px; height: 24px;";
  return button;
}

function activeArea(): FocusArea | undefined {
  const name = document.activeElement
    ?.closest<HTMLElement>("[data-focus-area]")
    ?.getAttribute("data-focus-area");
  return isFocusArea(name) ? name : undefined;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

test("move cycles the shown areas in reading order and skips an inert one", () => {
  const sidebarButton = control("Sidebar row");
  area("sidebar", sidebarButton);
  const mainInput = document.createElement("textarea");
  mainInput.setAttribute("aria-label", "Message");
  area("main", mainInput);
  const companionButton = control("Companion row");
  const companion = area("companion", companionButton);
  area("status", control("Dismiss status"));
  const controller = createAreaFocusController(document);
  dispose = controller.dispose;

  sidebarButton.focus();
  expect(controller.move(1)).toBe(true);
  expect(activeArea()).toBe("main");
  // The companion is inert, as a hidden group is.
  companion.setAttribute("inert", "");
  expect(controller.move(1)).toBe(true);
  expect(activeArea()).toBe("status");
  expect(controller.move(1)).toBe(true);
  expect(activeArea()).toBe("sidebar");
  expect(controller.move(-1)).toBe(true);
  expect(activeArea()).toBe("status");

  companion.removeAttribute("inert");
  companionButton.focus();
  expect(controller.move(1)).toBe(true);
  expect(activeArea()).toBe("status");
});

test("focusArea restores the area's last control, then its own fallback", () => {
  const first = control("First row");
  const second = control("Second row");
  area("sidebar", first, second);
  const input = document.createElement("textarea");
  input.setAttribute("aria-label", "Message");
  area("main", input);
  const controller = createAreaFocusController(document);
  dispose = controller.dispose;

  second.focus();
  input.focus();
  expect(controller.focusArea("sidebar")).toBe(true);
  expect(document.activeElement).toBe(second);

  second.remove();
  input.focus();
  expect(controller.focusArea("sidebar")).toBe(true);
  expect(document.activeElement).toBe(first);

  first.remove();
  input.focus();
  // An empty area is not a stop; focus stays where it was rather than falling to `body`.
  expect(controller.focusArea("sidebar")).toBe(false);
  expect(document.activeElement).toBe(input);
});

test("a request waits for the control React has not mounted yet", async () => {
  const root = area("main");
  const controller = createAreaFocusController(document);
  dispose = controller.dispose;
  controller.request({ area: "main", selector: "[data-late]" });

  const late = control("Late row");
  late.setAttribute("data-late", "");
  root.append(late);
  await vi.waitFor(() => expect(document.activeElement).toBe(late));
});

test("a pane request waits for the tab the layout selected", async () => {
  const oldTab = control("Old tab");
  oldTab.setAttribute("data-tab-id", "session:one");
  oldTab.setAttribute("aria-selected", "true");
  const root = area("main", oldTab);
  const controller = createAreaFocusController(document);
  dispose = controller.dispose;

  // The layout was written for the new tab; the DOM still shows the old one.
  controller.request({ area: "main", prefer: "pane", tab: "session:two" });
  await nextFrame();
  await nextFrame();
  expect(document.activeElement).not.toBe(oldTab);

  oldTab.removeAttribute("aria-selected");
  const newTab = control("New tab");
  newTab.setAttribute("data-tab-id", "session:two");
  newTab.setAttribute("aria-selected", "true");
  const message = document.createElement("textarea");
  message.setAttribute("aria-label", "Message");
  message.style.cssText = "width: 160px; height: 40px;";
  root.append(newTab, message);
  await vi.waitFor(() => expect(document.activeElement).toBe(message));
});

test("a request whose pane is replaced before the commit lands on the replacement", async () => {
  const root = area("main");
  const oldPane = document.createElement("div");
  const oldInput = document.createElement("textarea");
  oldInput.setAttribute("aria-label", "Message");
  oldInput.style.cssText = "width: 160px; height: 40px;";
  oldPane.append(oldInput);
  root.append(oldPane);
  const controller = createAreaFocusController(document);
  dispose = controller.dispose;

  controller.request({ area: "main", prefer: "pane" });
  await vi.waitFor(() => expect(document.activeElement).toBe(oldInput));

  // The layout write the request raced takes the old pane away; the new one owns the tab now.
  oldPane.remove();
  const newPane = document.createElement("div");
  const newInput = document.createElement("textarea");
  newInput.setAttribute("aria-label", "Message");
  newInput.style.cssText = "width: 160px; height: 40px;";
  newPane.append(newInput);
  root.append(newPane);

  await vi.waitFor(() => expect(document.activeElement).toBe(newInput));
});

test("a pane replaced after the request settled still recovers", async () => {
  const root = area("main");
  const pane = document.createElement("div");
  const oldInput = document.createElement("textarea");
  oldInput.setAttribute("aria-label", "Message");
  oldInput.style.cssText = "width: 160px; height: 40px;";
  pane.append(oldInput);
  root.append(pane);
  const controller = createAreaFocusController(document);
  dispose = controller.dispose;

  controller.request({ area: "main", prefer: "pane" });
  await vi.waitFor(() => expect(document.activeElement).toBe(oldInput));
  // The request has given up by now; the pane is replaced later, as a reconnect can do.
  await new Promise((resolve) => setTimeout(resolve, 700));
  pane.remove();
  const nextPane = document.createElement("div");
  const nextInput = document.createElement("textarea");
  nextInput.setAttribute("aria-label", "Message");
  nextInput.style.cssText = "width: 160px; height: 40px;";
  nextPane.append(nextInput);
  root.append(nextPane);

  await vi.waitFor(() => expect(document.activeElement).toBe(nextInput));
});

test("focusing a tab cancels a pending pane request", async () => {
  const root = area("main");
  const tab = control("Tab");
  tab.setAttribute("role", "tab");
  root.append(tab);
  const controller = createAreaFocusController(document);
  dispose = controller.dispose;

  controller.request({ area: "main", selector: "[data-late]" });
  tab.focus();
  const late = control("Late row");
  late.setAttribute("data-late", "");
  root.append(late);
  await nextFrame();
  await nextFrame();
  expect(document.activeElement).toBe(tab);
});

test("a request is cancelled by the next user input", async () => {
  area("main", control("Present"));
  const controller = createAreaFocusController(document);
  dispose = controller.dispose;
  controller.request({ area: "main", prefer: "pane" });
  await Promise.resolve();
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { code: "KeyA", key: "a", bubbles: true }),
  );
  await nextFrame();
  await nextFrame();
  expect(activeArea()).toBeUndefined();
});

test("a removed control recovers to its remounted self, else to its area", async () => {
  const remountedButton = control("Row one");
  const other = control("Other row");
  const root = area("sidebar", remountedButton, other);
  const replacement = control("Row one");
  const controller = createAreaFocusController(document);
  dispose = controller.dispose;

  remountedButton.focus();
  remountedButton.remove();
  root.append(replacement);
  await vi.waitFor(() => expect(document.activeElement).toBe(replacement));

  // Without a remount the area takes the keyboard, not `body`.
  replacement.remove();
  await vi.waitFor(() => expect(document.activeElement).toBe(other));
});

test("a shown dialog keeps every area move where it is", () => {
  area("sidebar", control("Sidebar row"));
  area("main", control("Main button"));
  const controller = createAreaFocusController(document);
  dispose = controller.dispose;
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.style.cssText = "width: 100px; height: 100px;";
  document.body.append(dialog);
  mounted.push(dialog);

  const active = document.activeElement;
  expect(controller.move(1)).toBe(false);
  expect(document.activeElement).toBe(active);
});

test("F6 moves areas where a browser keeps the key, and a dialog consumes it", () => {
  const sidebarButton = control("Sidebar row");
  area("sidebar", sidebarButton);
  area("main", control("Main button"));
  dispose = startShellFocus({ desktop: true });
  sidebarButton.focus();

  window.dispatchEvent(
    new KeyboardEvent("keydown", { code: "F6", bubbles: true, cancelable: true }),
  );
  expect(activeArea()).toBe("main");
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      code: "F6",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(activeArea()).toBe("sidebar");

  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.style.cssText = "width: 100px; height: 100px;";
  document.body.append(dialog);
  mounted.push(dialog);
  const event = new KeyboardEvent("keydown", { code: "F6", bubbles: true, cancelable: true });
  window.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(activeArea()).toBe("sidebar");
});

test("a control whose area went away recovers to the work surface", async () => {
  const row = control("Row");
  const sidebar = area("sidebar", row);
  const mainButton = control("Main button");
  area("main", mainButton);
  const controller = createAreaFocusController(document);
  dispose = controller.dispose;

  row.focus();
  sidebar.remove();
  await vi.waitFor(() => expect(document.activeElement).toBe(mainButton));
});

test("the connection banner is the status stop while it shows", () => {
  area("status", control("Dismiss status"));
  const banner = document.createElement("div");
  banner.setAttribute("data-focus-area", "status");
  banner.setAttribute("data-slot", "connection-banner");
  banner.tabIndex = -1;
  banner.style.cssText = "width: 200px; height: 40px;";
  const retry = control("Retry now");
  banner.append(retry);
  document.body.append(banner);
  mounted.push(banner);
  const controller = createAreaFocusController(document);
  dispose = controller.dispose;

  expect(controller.focusArea("status")).toBe(true);
  expect(document.activeElement).toBe(retry);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  for (const element of mounted.splice(0)) element.remove();
});
