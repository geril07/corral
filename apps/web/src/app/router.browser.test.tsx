import { createHashHistory } from "@tanstack/react-router";
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
