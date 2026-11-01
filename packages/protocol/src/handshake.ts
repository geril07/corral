import { z } from "zod";

/**
 * Bumped on any wire change a peer of the other version would misread. Version 2 introduced
 * the transport capability; version 3 the launch profile/model session fields; version 4 the
 * settings action and its binding; version 5 the optional task source in create and watch. A
 * version 4 server strips `source` as an unknown field, so a client must not reuse it. Version 4
 * clients are likewise refused instead of silently losing the new settings binding. Version 6
 * adds the task title source and `tasks.rename` plus the rename-task and session-number actions,
 * and the required task, naming and project settings in the config state: a version 5 server's
 * tasks have no title source, its config lacks those bindings and it never sends the settings, so
 * a version 5 client and a version 6 client each misread the other's replies. Version 7 adds the
 * sidebar-mode action, the server-owned task `seenAt` and the task's prompt and primary session:
 * a version 6 server strips the binding and the fields, has no `seen_at` column and answers
 * `tasks.markSeen` with an unknown procedure. Version 8 adds the toggle-sidebar action: a
 * version 7 server strips that binding from its exhaustive keys. Version 9 adds the `chat.*`
 * contract, `Session.view` and the pi chat driver (B1's migration gives every stored session a
 * view), `sessions.setView`, the abort-turn, change-model, change-reasoning and switch-view
 * actions, `[tasks] view = "chat"`, `[agents.<kind>]` with its `AGENT_DISABLED` refusal, and
 * `ConfigState.agents`: a version 8 server has no chat procedures at all, its sessions carry no
 * view, it strips those bindings from its exhaustive keys and its config has neither the agent
 * tables nor the availability list. Version 10 adds the per-agent capability record in
 * `chat.capabilities` (goal D7, decision 13): a version 9 server answers `{ drivers: AgentKind[] }`,
 * so a version 10 client asking for the record would receive a list of bare strings whose fields it
 * reads as absent, and its controls would claim a capability no driver declared. The same version 10
 * grew the `changes.*` read model (a task's changed files, one file's capped diff) and the `changes`
 * action with its binding: a version 10 daemon from before C4 answers neither procedure, so the
 * client's default binding for the action is all it has and the tab reports that this server does
 * not offer changes instead of showing an empty one.
 * grew C5's additions, both optional for a daemon already on 10: the `files.*` procedures
 * (`resolve`, `read`, `openEditor`) behind chat's local links, which an older 10 answers as unknown
 * procedures, and `ClientConfig.editor` (`[editor] command`) with the empty-command default, so a
 * client that reads it from an older 10 falls back to `$VISUAL`/`$EDITOR` exactly as the server does.
 * C6 grew 10's write path as well, with the same rule: `changes.finish`, `changes.stage`,
 * `changes.commit`, `changes.push`, `changes.createPullRequest` and `changes.pullRequest` are
 * procedures a daemon from before C6 answers as unknown, so the Changes tab says the action is
 * unavailable there and the badge stays absent instead of showing a write that never ran. */
export const PROTOCOL_VERSION = 10;

/**
 * Every WebSocket URL carries the client's version as `?protocol=N`. The handshake lives in
 * the URL rather than in a first message because oRPC owns every message on the RPC socket.
 */
export const PROTOCOL_QUERY_PARAM = "protocol";

/**
 * On a mismatch the server completes the upgrade and closes with this code: browsers cannot
 * read an HTTP rejection of an upgrade, but they can read a close code and reason.
 */
export const PROTOCOL_MISMATCH_CLOSE_CODE = 4001;

export const ProtocolMismatchReason = z.object({ serverProtocolVersion: z.number().int() });
export type ProtocolMismatchReason = z.infer<typeof ProtocolMismatchReason>;

/**
 * The capability travels as a WebSocket subprotocol, never in the URL: browsers can set
 * subprotocols but not headers, and URLs end up in logs, diagnostics and Referer headers.
 * The marker is negotiated back so the token itself is not echoed in the response.
 */
export const CAPABILITY_SUBPROTOCOL = "corral.capability";

/** What a client offers when it opens a socket to a server. */
export function capabilityProtocols(capability: string): string[] {
  if (capability.length === 0) throw new Error("server capability is empty");
  return [CAPABILITY_SUBPROTOCOL, capability];
}

/** Server side: the capability offered after the marker, if a client offered one. */
export function capabilityFromProtocols(protocols: Iterable<string>): string | undefined {
  const offered = [...protocols];
  const marker = offered.indexOf(CAPABILITY_SUBPROTOCOL);
  return marker === -1 ? undefined : offered[marker + 1];
}

/** Adds the protocol version to a server URL and a path such as `/rpc`. */
export function protocolUrl(serverUrl: string, path: string): string {
  const url = new URL(path, serverUrl);
  url.searchParams.set(PROTOCOL_QUERY_PARAM, String(PROTOCOL_VERSION));
  return url.toString();
}

/** Server side: `null` when the client speaks our version, else the close reason to send. */
export function checkProtocolVersion(url: URL): ProtocolMismatchReason | null {
  return url.searchParams.get(PROTOCOL_QUERY_PARAM) === String(PROTOCOL_VERSION)
    ? null
    : { serverProtocolVersion: PROTOCOL_VERSION };
}
