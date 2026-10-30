import { expect, test } from "vite-plus/test";
import { resolveServerUrl } from "./server-url.ts";

const page = { search: "", protocol: "http:", host: "localhost:5173" };

test("the ?server= parameter wins", () => {
  expect(resolveServerUrl({ ...page, search: "?server=ws://127.0.0.1:4000" })).toBe(
    "ws://127.0.0.1:4000",
  );
});

test("without it the page's own origin is used, secure when the page is", () => {
  expect(resolveServerUrl(page)).toBe("ws://localhost:5173");
  expect(resolveServerUrl({ ...page, protocol: "https:", host: "corral.example" })).toBe(
    "wss://corral.example",
  );
});

test("a server parameter that is not a websocket URL, or no origin to fall back to, is an error", () => {
  expect(() => resolveServerUrl({ ...page, search: "?server=http://x" })).toThrow(
    "ws:// or wss://",
  );
  expect(() => resolveServerUrl({ ...page, search: "?server=" })).toThrow("ws:// or wss://");
  expect(() => resolveServerUrl({ search: "", protocol: "file:", host: "" })).toThrow("no origin");
});
