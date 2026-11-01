import { expect, test } from "vite-plus/test";
import { externalUrl } from "@corral/protocol/external-url";
import { isAppNavigation } from "./external-links.ts";

test("http and https links go to the OS browser; everything else is refused", () => {
  expect(externalUrl("https://github.com/acme/app/issues/7")).toBe(
    "https://github.com/acme/app/issues/7",
  );
  expect(externalUrl("http://example.com/")).toBe("http://example.com/");

  for (const value of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,hi",
    "mailto:dev@example.com",
    "not a url",
  ]) {
    expect(externalUrl(value)).toBeUndefined();
  }
});

test("the app may reload its own bundle or stay on the dev origin, but not navigate elsewhere", () => {
  const bundle = "file:///opt/corral/apps/web/dist/index.html";
  expect(isAppNavigation(bundle, `${bundle}?server=ws%3A%2F%2F127.0.0.1%3A4000#/board`)).toBe(true);
  expect(isAppNavigation(bundle, "file:///tmp/attacker.html")).toBe(false);
  expect(isAppNavigation(bundle, "https://example.com/")).toBe(false);

  const dev = "http://localhost:5173/app";
  expect(isAppNavigation(dev, "http://localhost:5173/tasks/1")).toBe(true);
  expect(isAppNavigation(dev, "http://127.0.0.1:5173/app")).toBe(false);
  expect(isAppNavigation(dev, "https://example.com/")).toBe(false);
});
