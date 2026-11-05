import { expect, test } from "vite-plus/test";
import { expandHomePath } from "./home-path.ts";

test("a leading ~ expands to the server's home, and separators collapse", () => {
  expect(expandHomePath("/data/worktrees", "/home/me")).toBe("/data/worktrees");
  expect(expandHomePath("/data//worktrees/", "/home/me")).toBe("/data/worktrees");
  expect(expandHomePath("~", "/home/me")).toBe("/home/me");
  expect(expandHomePath("~/", "/home/me")).toBe("/home/me");
  expect(expandHomePath("~/wt", "/home/me")).toBe("/home/me/wt");
  expect(expandHomePath("~//wt", "/home/me")).toBe("/home/me/wt");
  expect(expandHomePath("~/./wt", "/home/me")).toBe("/home/me/wt");
});

test.runIf(process.platform === "win32")(
  "a Windows drive path and ~ use the platform's separators",
  () => {
    expect(expandHomePath("C:\\wt", "C:\\Users\\me")).toBe("C:\\wt");
    expect(expandHomePath("~/wt", "C:\\Users\\me")).toBe("C:\\Users\\me\\wt");
  },
);
