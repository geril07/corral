import { expect, test } from "vite-plus/test";
import { resolveStateDir } from "./server-endpoint.ts";

test("state dir: CORRAL_STATE_DIR wins, then XDG_STATE_HOME, then the home default", () => {
  const home = "/home/u";
  expect(resolveStateDir({ CORRAL_STATE_DIR: "/x", XDG_STATE_HOME: "/s" }, home)).toBe("/x");
  expect(resolveStateDir({ XDG_STATE_HOME: "/s" }, home)).toBe("/s/corral");
  expect(resolveStateDir({}, home)).toBe("/home/u/.local/state/corral");
  expect(resolveStateDir({ CORRAL_STATE_DIR: "", XDG_STATE_HOME: "" }, home)).toBe(
    "/home/u/.local/state/corral",
  );
});
