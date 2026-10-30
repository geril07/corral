// Reports what OpenCode is doing to the Corral server that launched it.
//
// Derived from herdr's `src/integration/assets/opencode/herdr-agent-state.js`
// (https://github.com/herdrdev/herdr, Apache License 2.0, http://www.apache.org/licenses/LICENSE-2.0).
// Changes: ported to the OpenCode 2 plugin API (`setup(ctx)` and `ctx.event.subscribe()` instead of
// the V1 `event` hook), reports go over HTTP to the Corral server instead of herdr's socket, and the
// state is derived from OpenCode 2's session execution events.
//
// The server writes this file into its data directory and loads it only into the OpenCode processes
// it starts (`opencode --standalone`, so the plugin runs in that process and sees its environment).
// Keep it one dependency-free file: it runs inside OpenCode, not inside Corral.

const SOURCE_TIMEOUT_MS = 2000;
const MAX_MESSAGE_LENGTH = 500;

function truncate(text) {
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : text;
}

function describePermission(request) {
  if (typeof request.message === "string" && request.message) return truncate(request.message);
  const resources = Array.isArray(request.resources) ? request.resources.join(", ") : "";
  return truncate([request.action, resources].filter(Boolean).join(" ") || "permission requested");
}

/**
 * What the OpenCode process is doing, from its event stream. A subagent runs in a child session
 * (`session.created` carries its `parentID`): its work and its questions count for the process,
 * but only the root sessions' endings decide `done`, `idle` and `error`.
 */
export function createActivity() {
  const parents = new Map();
  const running = new Set();
  // Oldest first: a map keeps insertion order, and the longest-waiting request is the one to answer first.
  const blockers = new Map();
  let outcome;

  function drop(sessionID) {
    running.delete(sessionID);
    parents.delete(sessionID);
    for (const [key, blocker] of blockers)
      if (blocker.sessionID === sessionID) blockers.delete(key);
  }

  function ended(sessionID, result) {
    running.delete(sessionID);
    if (!parents.has(sessionID)) outcome = result;
  }

  return {
    /** Feeds one event; returns nothing. */
    apply(event) {
      const data = event?.data;
      if (!data || typeof data !== "object") return;
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
      switch (event.type) {
        case "session.created":
          if (sessionID && typeof data.parentID === "string") parents.set(sessionID, data.parentID);
          break;
        case "session.deleted":
          if (sessionID) drop(sessionID);
          break;
        case "session.execution.started":
          if (!sessionID) break;
          running.add(sessionID);
          if (!parents.has(sessionID)) outcome = undefined;
          break;
        case "session.execution.succeeded":
          if (sessionID) ended(sessionID, { state: "done" });
          break;
        case "session.execution.interrupted":
          if (sessionID) ended(sessionID, { state: "idle" });
          break;
        case "session.execution.failed":
          if (sessionID) {
            const message = data.error?.message;
            ended(sessionID, {
              state: "error",
              ...(typeof message === "string" && message ? { message: truncate(message) } : {}),
            });
          }
          break;
        case "permission.asked":
          if (sessionID && typeof data.id === "string") {
            blockers.set(`permission:${data.id}`, {
              sessionID,
              kind: "permission",
              message: describePermission(data),
            });
          }
          break;
        case "permission.replied":
          blockers.delete(`permission:${data.requestID}`);
          break;
        case "form.created": {
          const form = data.form;
          if (typeof form?.id === "string" && typeof form.sessionID === "string") {
            blockers.set(`form:${form.id}`, {
              sessionID: form.sessionID,
              kind: "question",
              ...(typeof form.title === "string" && form.title
                ? { message: truncate(form.title) }
                : {}),
            });
          }
          break;
        }
        case "form.replied":
        case "form.cancelled":
          blockers.delete(`form:${data.id}`);
          break;
        default:
          break;
      }
    },

    /** The status report for now, or undefined while OpenCode has done nothing yet. */
    report() {
      const blocker = blockers.values().next().value;
      if (blocker) {
        return {
          state: "blocked",
          kind: blocker.kind,
          ...(blocker.message ? { message: blocker.message } : {}),
        };
      }
      if (running.size > 0) return { state: "working" };
      return outcome;
    },
  };
}

/**
 * Posts reports to the Corral server one at a time, skipping a repeat of the last one delivered.
 * A report that cannot be delivered is dropped; the next change sends the state again.
 */
export function createSender({ url, token, fetch }) {
  let chain = Promise.resolve();
  let delivered;

  async function post(report) {
    const key = JSON.stringify(report);
    if (key === delivered) return;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: key,
        signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      });
      delivered = response.ok ? key : undefined;
    } catch {
      delivered = undefined;
    }
  }

  return (report) => {
    chain = chain.then(() => post(report));
    return chain;
  };
}

/** Applies every event of `events` to a fresh activity and sends the status after each one. */
export async function reportEvents(events, send) {
  const activity = createActivity();
  for await (const event of events) {
    activity.apply(event);
    const report = activity.report();
    if (report) await send(report);
  }
}

export function createPlugin({ env = process.env, fetch = globalThis.fetch } = {}) {
  return {
    id: "corral.status",
    setup(ctx) {
      const url = env.CORRAL_STATUS_URL;
      const token = env.CORRAL_STATUS_TOKEN;
      if (!url || !token) return undefined;
      const controller = new AbortController();
      const send = createSender({ url, token, fetch });
      void reportEvents(ctx.event.subscribe({ signal: controller.signal }), send).catch(() => {});
      return () => controller.abort();
    },
  };
}

export default createPlugin();
