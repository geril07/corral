import { createHashHistory, createMemoryHistory } from "@tanstack/react-router";
import { createAppHistory } from "./history.ts";
import { createAppRouter } from "./router.tsx";
import { expect, test, vi } from "vite-plus/test";

// The desktop app loads the page as file://...?server=<ws url>; the route lives after the hash.
const DESKTOP_URL = "/?server=ws%3A%2F%2F127.0.0.1%3A4317#/";

test("hash navigation keeps the ?server= query before the hash", () => {
  const original = window.location.href;
  try {
    window.history.replaceState({}, "", DESKTOP_URL);
    const history = createHashHistory();
    expect(window.location.search).toBe("?server=ws%3A%2F%2F127.0.0.1%3A4317");

    history.push("/settings?task=t1&entry=e1");
    history.flush();

    expect(window.location.hash).toBe("#/settings?task=t1&entry=e1");
    expect(window.location.search).toBe("?server=ws%3A%2F%2F127.0.0.1%3A4317");
    history.destroy();
  } finally {
    window.history.replaceState({}, "", original);
  }
});

test("the desktop server query stays out of the hash route search", async () => {
  const original = window.location.href;
  try {
    window.history.replaceState(
      {},
      "",
      "/?server=ws%3A%2F%2F127.0.0.1%3A4317#/?project=p1&task=t1&entry=e1",
    );
    const router = createAppRouter();
    await router.load();

    expect(router.state.location.search).toEqual({ project: "p1", task: "t1", entry: "e1" });
    router.history.destroy();
  } finally {
    window.history.replaceState({}, "", original);
  }
});

test("id-looking values stay strings in the route search", async () => {
  const original = window.location.href;
  try {
    const href =
      "/?server=ws%3A%2F%2F127.0.0.1%3A4317#/?project=123456789012&task=123e4567&entry=123456789012";
    window.history.replaceState({}, "", href);
    const router = createAppRouter();
    await router.load();

    expect(router.state.location.search).toEqual({
      project: "123456789012",
      task: "123e4567",
      entry: "123456789012",
    });
    router.history.destroy();
  } finally {
    window.history.replaceState({}, "", original);
  }
});

async function roundTrip(search: { project: string; task: string; entry: string }) {
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const router = createAppRouter(history);
  await router.load();
  await router.navigate({ to: "/", search });

  const href = history.location.href;
  router.history.destroy();

  const freshHistory = createMemoryHistory({ initialEntries: [href] });
  const fresh = createAppRouter(freshHistory);
  await fresh.load();
  const parsed = fresh.state.location.search;
  fresh.history.destroy();
  return { href, parsed };
}

test("navigate-generated URLs keep numeric and scientific-looking ids unquoted", async () => {
  const search = { project: "123456789012", task: "123e4567", entry: "abc?x=1" };
  const { href, parsed } = await roundTrip(search);

  expect(href).toContain("project=123456789012");
  expect(href).toContain("task=123e4567");
  expect(href).toContain("entry=abc%3Fx%3D1");
  expect(parsed).toEqual(search);
});

test("navigate-generated URLs keep normal string ids unquoted", async () => {
  const search = { project: "abcdef123456", task: "0123456789ab", entry: "plain-id" };
  const { href, parsed } = await roundTrip(search);

  expect(href).toContain("project=abcdef123456");
  expect(href).toContain("task=0123456789ab");
  expect(href).toContain("entry=plain-id");
  expect(parsed).toEqual(search);
});

test("legacy quoted string ids load through a fresh router", async () => {
  const href = "/?project=%22123456789012%22&task=%22123e4567%22&entry=%22abc%3Fx%3D1%22";
  const history = createMemoryHistory({ initialEntries: [href] });
  const router = createAppRouter(history);
  await router.load();

  expect(router.state.location.search).toEqual({
    project: "123456789012",
    task: "123e4567",
    entry: "abc?x=1",
  });
  router.history.destroy();
});

test("a browser-created hash entry is FORWARD, not BACK, once it has an index", async () => {
  const original = window.location.href;
  let history: ReturnType<typeof createAppHistory> | undefined;
  try {
    window.history.replaceState({}, "", "/#/");
    history = createAppHistory();
    const actions: string[] = [];
    history.subscribe(({ action }) => actions.push(action.type));
    history.push("/settings");
    history.flush();
    expect(history.location.state["__TSR_index"]).toBe(1);

    // The address-bar equivalent: a native fragment entry with no TanStack state.
    window.location.hash = "#/";
    await vi.waitFor(() => expect(history?.location.pathname).toBe("/"));
    expect(actions).toEqual(["PUSH", "FORWARD"]);
    expect(history.location.state["__TSR_index"]).toBe(2);

    history.back();
    await vi.waitFor(() => expect(history?.location.pathname).toBe("/settings"));
    expect(actions).toEqual(["PUSH", "FORWARD", "BACK"]);
  } finally {
    history?.destroy();
    window.history.replaceState({}, "", original);
  }
});

/** A real window whose Navigation API result the test controls, or hides entirely. */
function windowWithNavigation(index: () => number | undefined): Window {
  return new Proxy(window, {
    get(target, property) {
      if (property === "navigation") {
        if (index() === undefined) return undefined;
        return {
          get currentEntry() {
            const current = index();
            return current === undefined ? null : { index: current };
          },
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("the app router indexes a browser-created entry through its own history", async () => {
  const original = window.location.href;
  let router: ReturnType<typeof createAppRouter> | undefined;
  try {
    window.history.replaceState({}, "", "/#/");
    router = createAppRouter();
    await router.load();
    const actions: string[] = [];
    router.history.subscribe(({ action }) => actions.push(action.type));
    router.history.push("/settings");
    router.history.flush();

    window.location.hash = "#/";
    await vi.waitFor(() => expect(router?.state.location.pathname).toBe("/"));
    expect(historyIndex(router.history.location.state)).toBe(2);
    expect(actions).toEqual(["PUSH", "FORWARD"]);
  } finally {
    router?.history.destroy();
    window.history.replaceState({}, "", original);
  }
});

function historyIndex(state: unknown) {
  if (typeof state !== "object" || state === null || !("__TSR_index" in state)) return undefined;
  return state["__TSR_index"];
}

test("the Navigation API branch positions a native entry by its session index", async () => {
  const original = window.location.href;
  let navigationIndex = 10;
  const win = windowWithNavigation(() => navigationIndex);
  let history: ReturnType<typeof createAppHistory> | undefined;
  try {
    window.history.replaceState({}, "", "/#/");
    history = createAppHistory(win);
    history.push("/settings");
    history.flush();

    // A value the lastIndex + 1 fallback would never produce.
    navigationIndex = 15;
    window.location.hash = "#/";
    await vi.waitFor(() => expect(history?.location.pathname).toBe("/"));
    expect(historyIndex(history.location.state)).toBe(5);
  } finally {
    history?.destroy();
    window.history.replaceState({}, "", original);
  }
});

test("without the Navigation API a native entry takes the next index", async () => {
  const original = window.location.href;
  const win = windowWithNavigation(() => undefined);
  let history: ReturnType<typeof createAppHistory> | undefined;
  try {
    window.history.replaceState({}, "", "/#/");
    history = createAppHistory(win);
    const actions: string[] = [];
    history.subscribe(({ action }) => actions.push(action.type));
    history.push("/settings");
    history.flush();

    window.location.hash = "#/";
    await vi.waitFor(() => expect(history?.location.pathname).toBe("/"));
    expect(historyIndex(history.location.state)).toBe(2);
    expect(actions).toEqual(["PUSH", "FORWARD"]);
  } finally {
    history?.destroy();
    window.history.replaceState({}, "", original);
  }
});

test("destroying app history stops the popstate normalizer", async () => {
  const original = window.location.href;
  let history: ReturnType<typeof createAppHistory> | undefined;
  try {
    window.history.replaceState({}, "", "/#/");
    history = createAppHistory();
    history.destroy();
    history = undefined;

    window.location.hash = "#/after-destroy";
    await vi.waitFor(() => expect(window.location.hash).toBe("#/after-destroy"));
    expect(window.history.state).toBeNull();
  } finally {
    history?.destroy();
    window.history.replaceState({}, "", original);
  }
});
