import { createHashHistory, createMemoryHistory } from "@tanstack/react-router";
import { createAppRouter } from "./router.tsx";
import { expect, test } from "vite-plus/test";

// The desktop app loads the page as file://...?server=<ws url>; the route lives after the hash.
const DESKTOP_URL = "/?server=ws%3A%2F%2F127.0.0.1%3A4317#/";

test("hash navigation keeps the ?server= query before the hash", () => {
  const original = window.location.href;
  try {
    window.history.replaceState({}, "", DESKTOP_URL);
    const history = createHashHistory();
    expect(window.location.search).toBe("?server=ws%3A%2F%2F127.0.0.1%3A4317");

    history.push("/board?task=t1&entry=e1");
    history.flush();

    expect(window.location.hash).toBe("#/board?task=t1&entry=e1");
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
