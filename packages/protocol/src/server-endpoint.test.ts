import { expect, test } from "vite-plus/test";
import { configFilePath, resolveConfigDir, resolveStateDir } from "./server-endpoint.ts";

test("state dir: CORRAL_STATE_DIR wins, then XDG_STATE_HOME, then the home default", () => {
  const home = "/home/u";
  expect(resolveStateDir({ CORRAL_STATE_DIR: "/x", XDG_STATE_HOME: "/s" }, home)).toBe("/x");
  expect(resolveStateDir({ XDG_STATE_HOME: "/s" }, home)).toBe("/s/corral");
  expect(resolveStateDir({}, home)).toBe("/home/u/.local/state/corral");
  expect(resolveStateDir({ CORRAL_STATE_DIR: "", XDG_STATE_HOME: "" }, home)).toBe(
    "/home/u/.local/state/corral",
  );
});

test("config dir: CORRAL_CONFIG_DIR wins, then XDG_CONFIG_HOME, then the home default", () => {
  const home = "/home/u";
  expect(resolveConfigDir({ CORRAL_CONFIG_DIR: "/x", XDG_CONFIG_HOME: "/c" }, home)).toBe("/x");
  expect(resolveConfigDir({ XDG_CONFIG_HOME: "/c" }, home)).toBe("/c/corral");
  expect(resolveConfigDir({}, home)).toBe("/home/u/.config/corral");
  expect(resolveConfigDir({ CORRAL_CONFIG_DIR: "", XDG_CONFIG_HOME: "" }, home)).toBe(
    "/home/u/.config/corral",
  );
  expect(configFilePath("/c/corral")).toBe("/c/corral/config.toml");
});
