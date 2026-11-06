import { expect, test } from "vite-plus/test";
import { modelFooterText } from "./model-footer.ts";

test("a settled footer names the draft state and the revision it was based on", () => {
  const cases = [
    [{ busy: false, dirty: false, revision: 0 }, "Saved · revision 0"],
    [{ busy: false, dirty: false, revision: 4 }, "Saved · revision 4"],
    [{ busy: false, dirty: true, revision: 0 }, "Unsaved changes · revision 0"],
    [{ busy: false, dirty: true, revision: 7 }, "Unsaved changes · revision 7"],
  ] as const;
  for (const [state, text] of cases) expect(modelFooterText(state)).toBe(text);
});

test("an in-flight save outranks the draft and carries no revision", () => {
  for (const dirty of [false, true])
    for (const revision of [0, 12])
      expect(modelFooterText({ busy: true, dirty, revision })).toBe("Saving…");
});

test("the in-flight label uses one ellipsis, not three dots", () => {
  expect(modelFooterText({ busy: true, dirty: true, revision: 1 })).toBe("Saving\u2026");
  expect(modelFooterText({ busy: true, dirty: true, revision: 1 })).not.toBe("Saving...");
});
