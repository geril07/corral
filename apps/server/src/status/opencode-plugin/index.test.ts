import { StatusReport } from "@corral/protocol/status-report";
import * as fc from "fast-check";
import { expect, test } from "vite-plus/test";

// A plain JavaScript file that runs inside OpenCode, so the test loads it the way OpenCode does.
type Send = (report: StatusReport) => Promise<void>;
type Setup = (ctx: unknown) => (() => void) | undefined;
type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<Response>;
const plugin: {
  default: { id: string; setup: Setup };
  createPlugin: (options: { env: Record<string, string>; fetch: Fetch }) => { setup: Setup };
  createActivity: () => { apply: (event: unknown) => void; report: () => StatusReport | undefined };
  createSender: (options: { url: string; token: string; fetch: Fetch }) => Send;
  reportEvents: (events: AsyncIterable<unknown>, send: Send) => Promise<void>;
} = await import(new URL("./index.js", import.meta.url).href);

const ROOT = "ses_root";
const CHILD = "ses_child";
const event = (type: string, data: object) => ({ type, data });
const started = (sessionID: string) => event("session.execution.started", { sessionID });
const succeeded = (sessionID: string) => event("session.execution.succeeded", { sessionID });
const subagent = event("session.created", { sessionID: CHILD, parentID: ROOT });

/** The reports the plugin would send for `events`, after each one. */
function reportsFor(...events: object[]): (StatusReport | undefined)[] {
  const activity = plugin.createActivity();
  return events.map((next) => {
    activity.apply(next);
    return activity.report();
  });
}

test("a turn is working until it ends: done when it succeeds, idle when interrupted, error when it fails", () => {
  expect(
    reportsFor(
      started(ROOT),
      succeeded(ROOT),
      started(ROOT),
      event("session.execution.interrupted", { sessionID: ROOT, reason: "user" }),
      started(ROOT),
      event("session.execution.failed", { sessionID: ROOT, error: { message: "rate limited" } }),
      started(ROOT),
    ),
  ).toEqual([
    { state: "working" },
    { state: "done" },
    { state: "working" },
    { state: "idle" },
    { state: "working" },
    { state: "error", message: "rate limited" },
    { state: "working" },
  ]);
});

test("only the first ending of a run counts, and an ending without a start is ignored", () => {
  expect(
    reportsFor(
      event("session.execution.interrupted", { sessionID: ROOT, reason: "shutdown" }),
      started(ROOT),
      event("session.execution.failed", { sessionID: ROOT, error: { message: "rate limited" } }),
      event("session.execution.interrupted", { sessionID: ROOT, reason: "superseded" }),
      succeeded(ROOT),
    ),
  ).toEqual([
    undefined,
    { state: "working" },
    { state: "error", message: "rate limited" },
    { state: "error", message: "rate limited" },
    { state: "error", message: "rate limited" },
  ]);
});

test("nothing is reported before OpenCode does something", () => {
  expect(
    reportsFor(event("session.viewed", { sessionID: ROOT }), event("model.updated", {})),
  ).toEqual([undefined, undefined]);
});

test("a permission request blocks until it is answered; so does a question form", () => {
  expect(
    reportsFor(
      started(ROOT),
      event("permission.asked", {
        id: "per_1",
        sessionID: ROOT,
        action: "bash",
        resources: ["rm -rf /"],
      }),
      event("permission.replied", { sessionID: ROOT, requestID: "per_1", reply: "once" }),
      event("form.created", { form: { id: "frm_1", sessionID: ROOT, title: "Which database?" } }),
      event("form.cancelled", { id: "frm_1", sessionID: ROOT }),
      event("permission.asked", {
        id: "per_2",
        sessionID: ROOT,
        action: "edit",
        resources: [],
        message: "Edit a.ts?",
      }),
      event("permission.replied", { sessionID: ROOT, requestID: "per_2", reply: "reject" }),
    ),
  ).toEqual([
    { state: "working" },
    { state: "blocked", kind: "permission", message: "bash rm -rf /" },
    { state: "working" },
    { state: "blocked", kind: "question", message: "Which database?" },
    { state: "working" },
    { state: "blocked", kind: "permission", message: "Edit a.ts?" },
    { state: "working" },
  ]);
});

test("a subagent's request blocks the process, and its work keeps the root working", () => {
  expect(
    reportsFor(
      started(ROOT),
      subagent,
      started(CHILD),
      event("permission.asked", { id: "per_1", sessionID: CHILD, action: "bash", resources: [] }),
      event("permission.replied", { sessionID: CHILD, requestID: "per_1", reply: "once" }),
      succeeded(ROOT),
      succeeded(CHILD),
    ),
  ).toEqual([
    { state: "working" },
    { state: "working" },
    { state: "working" },
    { state: "blocked", kind: "permission", message: "bash" },
    { state: "working" },
    // The root's turn ended while the subagent still runs.
    { state: "working" },
    { state: "done" },
  ]);
});

test("a subagent that fails or is interrupted does not decide the root's outcome", () => {
  expect(
    reportsFor(
      started(ROOT),
      subagent,
      started(CHILD),
      event("session.execution.failed", { sessionID: CHILD, error: { message: "child broke" } }),
      event("session.execution.interrupted", { sessionID: CHILD, reason: "user" }),
    ),
  ).toEqual([
    { state: "working" },
    { state: "working" },
    { state: "working" },
    { state: "working" },
    { state: "working" },
  ]);
});

test("deleting a session drops its open requests", () => {
  const reports = reportsFor(
    started(ROOT),
    subagent,
    event("form.created", { form: { id: "frm_1", sessionID: CHILD, title: "Pick" } }),
    event("session.deleted", { sessionID: CHILD }),
  );
  expect(reports.at(-1)).toEqual({ state: "working" });
});

test("the longest-waiting request is the one reported", () => {
  const reports = reportsFor(
    event("permission.asked", { id: "per_1", sessionID: ROOT, action: "first", resources: [] }),
    event("form.created", { form: { id: "frm_1", sessionID: ROOT, title: "second" } }),
    event("permission.replied", { sessionID: ROOT, requestID: "per_1", reply: "once" }),
  );
  expect(reports.map((report) => report?.message)).toEqual(["first", "first", "second"]);
});

test("every report the plugin can make is one the server accepts", () => {
  const long = "x".repeat(5000);
  const reports = reportsFor(
    started(ROOT),
    event("session.execution.failed", { sessionID: ROOT, error: { message: long } }),
    event("permission.asked", { id: "per_1", sessionID: ROOT, action: long, resources: [long] }),
    event("form.created", { form: { id: "frm_1", sessionID: ROOT, title: long } }),
  );
  for (const report of reports) expect(StatusReport.safeParse(report).success).toBe(true);
});

test("events of any shape are ignored without throwing", () => {
  fc.assert(
    fc.property(fc.array(fc.anything()), (events) => {
      const activity = plugin.createActivity();
      expect(() => {
        for (const next of events) activity.apply(next);
        activity.report();
      }).not.toThrow();
    }),
  );
});

function fakeFetch(statuses: number[] = []) {
  const calls: { url: string; init: Parameters<Fetch>[1] }[] = [];
  const impl: Fetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(null, { status: statuses.shift() ?? 204 }));
  };
  return { calls, impl };
}

async function* stream(...events: object[]) {
  await Promise.resolve();
  yield* events;
}

test("reports go to the Corral server in order, with the bearer token, and a repeat is not sent twice", async () => {
  const fake = fakeFetch();
  const send = plugin.createSender({ url: "http://127.0.0.1:1/s", token: "tok", fetch: fake.impl });

  await plugin.reportEvents(
    stream(
      started(ROOT),
      event("session.status", { sessionID: ROOT }),
      event("permission.asked", { id: "per_1", sessionID: ROOT, action: "bash", resources: [] }),
      event("permission.replied", { sessionID: ROOT, requestID: "per_1", reply: "once" }),
      succeeded(ROOT),
    ),
    send,
  );

  expect(fake.calls.map((call) => JSON.parse(call.init.body))).toEqual([
    { state: "working" },
    { state: "blocked", kind: "permission", message: "bash" },
    { state: "working" },
    { state: "done" },
  ]);
  expect(fake.calls[0]).toMatchObject({
    url: "http://127.0.0.1:1/s",
    init: { method: "POST", headers: { authorization: "Bearer tok" } },
  });
});

test("a report the server did not take is sent again with the next event", async () => {
  const fake = fakeFetch([403, 204]);
  const send = plugin.createSender({ url: "http://x/s", token: "t", fetch: fake.impl });

  await send({ state: "working" });
  await send({ state: "working" });
  await send({ state: "working" });

  expect(fake.calls).toHaveLength(2);
});

test("an unreachable server never breaks OpenCode", async () => {
  const send = plugin.createSender({
    url: "http://x/s",
    token: "t",
    fetch: () => Promise.reject(new Error("connection refused")),
  });
  await expect(send({ state: "working" })).resolves.toBeUndefined();
});

test("outside a Corral session the plugin does nothing", () => {
  const fake = fakeFetch();
  let subscribed = false;
  const ctx = {
    event: {
      subscribe() {
        subscribed = true;
        return stream();
      },
    },
  };
  const { setup } = plugin.createPlugin({ env: {}, fetch: fake.impl });
  expect(setup(ctx)).toBeUndefined();
  expect(subscribed).toBe(false);
});

test("inside a Corral session it follows OpenCode's event stream until unloaded", async () => {
  const fake = fakeFetch();
  const ctx = {
    event: {
      async *subscribe({ signal }: { signal: AbortSignal }) {
        yield started(ROOT);
        await new Promise((resolve) => signal.addEventListener("abort", resolve));
      },
    },
  };
  const { setup } = plugin.createPlugin({
    env: { CORRAL_STATUS_URL: "http://127.0.0.1:1/s", CORRAL_STATUS_TOKEN: "tok" },
    fetch: fake.impl,
  });

  const unload = setup(ctx);
  await expect.poll(() => fake.calls.length, { timeout: 5000 }).toBe(1);
  unload?.();

  expect(JSON.parse(fake.calls[0]!.init.body)).toEqual({ state: "working" });
});

test("the module OpenCode loads is the plugin for this environment", () => {
  expect(plugin.default.id).toBe("corral.status");
  expect(typeof plugin.default.setup).toBe("function");
});
