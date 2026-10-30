// Cases ported from Orca's `src/shared/program-status/protocol.test.ts` (MIT, Copyright (c) 2026 Lovecast Inc.).
import * as fc from "fast-check";
import { expect, test } from "vite-plus/test";
import { reportBody } from "../../test/osc7501.ts";
import { QUERY_REPLY, parseBody } from "./osc7501-protocol.ts";

// oxlint-disable-next-line no-control-regex -- the spec refuses these in text
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");

test("the probe is recognized and answered with the states and kinds we accept", () => {
  expect(parseBody("?")).toEqual({ type: "query" });
  expect(parseBody(" ? ")).toEqual({ type: "query" });
  const [, states, kinds] = /states=([a-z,]+):kinds=([a-z,]+)/.exec(QUERY_REPLY) ?? [];
  expect(QUERY_REPLY.startsWith("\x1b]7501;?:")).toBe(true);
  expect(QUERY_REPLY.endsWith("\x1b\\")).toBe(true);
  expect(states?.split(",").toSorted()).toEqual(["blocked", "done", "error", "idle", "working"]);
  expect(kinds?.split(",").toSorted()).toEqual(["auth", "permission", "question"]);
});

test("the spec example with a base64 message parses", () => {
  const msg = "Apply 3 to add, 1 to change, 0 to destroy?";
  expect(parseBody(`state=blocked:kind=permission:app=terraform:msg=${b64(msg)}`)).toEqual({
    type: "report",
    report: { id: null, state: "blocked", kind: "permission", msg },
  });
});

test("unpadded base64 and UTF-8 text decode", () => {
  const encoded = b64("déjà vu ✓").replace(/=+$/, "");
  expect(parseBody(`state=done:msg=${encoded}`)).toMatchObject({ report: { msg: "déjà vu ✓" } });
});

test("a report without a recognized state or with a malformed id is ignored", () => {
  expect(parseBody("app=x")).toBeNull();
  expect(parseBody("state=paused")).toBeNull();
  expect(parseBody("state=working:id=a//b")).toBeNull();
  expect(parseBody(`state=working:id=${"a/".repeat(8)}a`)).toBeNull();
});

test("a report is discarded for an over-long key or any over-limit occurrence", () => {
  expect(parseBody(`state=working:${"k".repeat(17)}=v`)).toBeNull();
  expect(parseBody(`state=done:msg=${b64("x".repeat(2049))}:msg=${b64("ok")}`)).toBeNull();
  expect(parseBody(`state=done:title=${b64("t".repeat(193))}:title=e`)).toBeNull();
  expect(parseBody(`state=clear:app=${"a".repeat(33)}`)).toBeNull();
  expect(parseBody(`state=clear:id=${"a".repeat(129)}:id=ok`)).toBeNull();
});

test("malformed pairs are skipped, whitespace is trimmed and the last repeat wins", () => {
  expect(parseBody(" state = idle :junk:K=v:app=a:app=b:x=has space")).toEqual({
    type: "report",
    report: { id: null, state: "idle" },
  });
  expect(parseBody("state=working:state=done")).toMatchObject({ report: { state: "done" } });
});

test("kind is kept only on blocked, and only the known kinds", () => {
  expect(parseBody("state=working:kind=permission")).toEqual({
    type: "report",
    report: { id: null, state: "working" },
  });
  expect(parseBody("state=blocked:kind=unknown")).toEqual({
    type: "report",
    report: { id: null, state: "blocked" },
  });
  for (const kind of ["permission", "question", "auth"]) {
    expect(parseBody(`state=blocked:kind=${kind}`)).toMatchObject({ report: { kind } });
  }
});

test("text with a control character or bad base64 discards the whole report", () => {
  expect(parseBody(`state=done:msg=${b64("two\nlines")}`)).toBeNull();
  expect(parseBody(`state=done:title=${b64("\u0085")}`)).toBeNull();
  expect(parseBody("state=done:msg=a-b_")).toBeNull();
  expect(parseBody("state=done:msg=abcde")).toBeNull();
  expect(parseBody(`state=done:msg=${Buffer.from([0xff, 0xfe]).toString("base64")}`)).toBeNull();
  // Out-of-charset bytes make a malformed pair, which is skipped rather than fatal.
  expect(parseBody("state=done:msg=@@@@")).toEqual({
    type: "report",
    report: { id: null, state: "done" },
  });
});

test("message limits: 2048 decoded bytes pass, 2049 do not", () => {
  expect(parseBody(`state=done:msg=${b64("m".repeat(2048))}`)).not.toBeNull();
  expect(parseBody(`state=done:msg=${b64("m".repeat(2049))}`)).toBeNull();
});

test("clear works with and without an id", () => {
  expect(parseBody("state=clear")).toEqual({
    type: "report",
    report: { id: null, state: "clear" },
  });
  expect(parseBody("state=clear:id=build/test")).toEqual({
    type: "report",
    report: { id: "build/test", state: "clear" },
  });
});

test("a body over the sequence cap is ignored whole", () => {
  const room = 4096 - "\x1b]7501;".length - 1;
  const fits = `state=working:x=${"a".repeat(room - "state=working:x=".length)}`;
  expect(fits.length).toBe(room);
  expect(parseBody(fits)).not.toBeNull();
  expect(parseBody(`${fits}a`)).toBeNull();
});

test("malformed input of any shape never throws and stays bounded", () => {
  const piece = fc.oneof(
    fc.constantFrom(
      "state",
      "id",
      "kind",
      "msg",
      "title",
      "app",
      "=",
      ":",
      "/",
      "?",
      "working",
      "blocked",
      "clear",
    ),
    fc.string({ maxLength: 40 }),
    fc.string({ unit: "binary", maxLength: 40 }),
    fc.base64String({ maxLength: 60 }),
  );
  fc.assert(
    fc.property(fc.array(piece, { maxLength: 30 }), (pieces) => {
      const parsed = parseBody(pieces.join(""));
      const msg = parsed?.type === "report" ? parsed.report.msg : undefined;
      expect((msg?.length ?? 0) <= 2048).toBe(true);
    }),
    { numRuns: 2000 },
  );
  fc.assert(
    fc.property(fc.string({ maxLength: 20_000 }), (body) => {
      expect(() => parseBody(body)).not.toThrow();
    }),
  );
});

test("a report built by the encoder round-trips", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("working", "blocked", "done", "error", "idle"),
      fc.string({ minLength: 1, maxLength: 200 }).filter((text) => !CONTROL.test(text)),
      (state, msg) => {
        expect(parseBody(reportBody({ state, msg }))).toMatchObject({
          type: "report",
          report: { id: null, state, msg },
        });
      },
    ),
  );
});
