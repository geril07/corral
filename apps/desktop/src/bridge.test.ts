import { expect, test, vi } from "vite-plus/test";
import { openExternalRequest } from "./bridge.ts";

const actions = () => {
  const opened: string[] = [];
  return { opened, openExternal: (url: string) => opened.push(url) };
};

test("a page's open request hands only an ordinary web URL to the OS browser", () => {
  const shell = actions();
  openExternalRequest("https://github.com/acme/app/issues/7", shell);
  openExternalRequest("http://example.com/", shell);
  expect(shell.opened).toEqual(["https://github.com/acme/app/issues/7", "http://example.com/"]);
});

test("the shell re-checks the scheme, so a renderer cannot ask for a file or a script", () => {
  const shell = actions();
  const reject = vi.fn<(url: string) => void>();
  for (const value of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,hi",
    "mailto:dev@example.com",
    "not a url",
    "",
    null,
    undefined,
    42,
    { href: "https://example.com/" },
  ]) {
    openExternalRequest(value, { openExternal: reject });
  }
  expect(reject).not.toHaveBeenCalled();
  expect(shell.opened).toEqual([]);
});
