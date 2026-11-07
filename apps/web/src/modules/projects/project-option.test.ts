import { describe, expect, test } from "vite-plus/test";
import { projectOptionLabel } from "./project-option.tsx";

describe("projectOptionLabel", () => {
  test("carries the path so same-named projects stay distinguishable", () => {
    const first = projectOptionLabel({ name: "dup", path: "/work/first/dup" });
    const second = projectOptionLabel({ name: "dup", path: "/work/second/dup" });

    expect(first).toBe("dup /work/first/dup");
    expect(second).toBe("dup /work/second/dup");
    expect(first).not.toBe(second);
  });
});
