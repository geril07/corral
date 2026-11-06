import { expect, test } from "vite-plus/test";
import { modelFooterText } from "./model-footer.ts";

test("a settled footer names the draft state and the revision it was based on", () => {
  const cases = [
    [{ busy: false, dirty: false, loaded: true, failed: false, revision: 0 }, "Saved · revision 0"],
    [{ busy: false, dirty: false, loaded: true, failed: false, revision: 4 }, "Saved · revision 4"],
    [
      { busy: false, dirty: true, loaded: true, failed: false, revision: 0 },
      "Unsaved changes · revision 0",
    ],
    [
      { busy: false, dirty: true, loaded: true, failed: false, revision: 7 },
      "Unsaved changes · revision 7",
    ],
  ] as const;
  for (const [state, text] of cases) expect(modelFooterText(state)).toBe(text);
});

test("an in-flight save outranks the draft and carries no revision", () => {
  for (const dirty of [false, true])
    for (const loaded of [false, true])
      for (const revision of [0, 12])
        expect(modelFooterText({ busy: true, dirty, loaded, failed: false, revision })).toBe(
          "Saving…",
        );
});

test("unloaded preferences never claim a revision", () => {
  expect(
    modelFooterText({ busy: false, dirty: false, loaded: false, failed: true, revision: 0 }),
  ).toBe("Preferences unavailable");
  expect(
    modelFooterText({ busy: false, dirty: true, loaded: false, failed: true, revision: 9 }),
  ).toBe("Preferences unavailable");
  expect(
    modelFooterText({ busy: false, dirty: false, loaded: false, failed: false, revision: 0 }),
  ).toBe("Loading preferences…");
});

test("a loaded snapshot keeps the normal footer after a later refusal", () => {
  expect(
    modelFooterText({ busy: false, dirty: false, loaded: true, failed: true, revision: 3 }),
  ).toBe("Saved · revision 3");
  expect(
    modelFooterText({ busy: false, dirty: true, loaded: true, failed: true, revision: 3 }),
  ).toBe("Unsaved changes · revision 3");
});

test("the in-flight label uses one ellipsis, not three dots", () => {
  expect(
    modelFooterText({ busy: true, dirty: true, loaded: true, failed: false, revision: 1 }),
  ).toBe("Saving\u2026");
  expect(
    modelFooterText({ busy: true, dirty: true, loaded: true, failed: false, revision: 1 }),
  ).not.toBe("Saving...");
});
