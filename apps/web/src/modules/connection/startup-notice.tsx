import { CAPABILITY_HASH_PARAM, type ServerTargetFailure } from "@corral/client/bootstrap";
import type { ConnectionState } from "@corral/client/connection-state";
import { isCapabilityToken, PROTOCOL_VERSION } from "@corral/protocol/handshake";
import { useEffect, useState } from "react";
import { useNow } from "../../common/hooks/use-now.ts";
import { Button, ContentLane, FormField, Input, TaskDialog } from "../../common/ui/index.ts";
import { useCorralClient, useConnection } from "./client-context.tsx";

/** Everything the framed notice can be about. */
export type NoticeProblem =
  | { kind: "boot"; failure: ServerTargetFailure | undefined; message: string }
  | {
      kind: "connecting";
      attempt: number;
      startedAt: number;
      serverUrl?: string | undefined;
    }
  | {
      kind: "unreachable";
      attempt: number;
      startedAt: number;
      serverUrl?: string | undefined;
    }
  | {
      kind: "capability-refused";
      attempt: number;
      startedAt: number;
      serverUrl?: string | undefined;
    }
  | { kind: "invalid-capability"; detail?: string | undefined; serverUrl?: string | undefined }
  | { kind: "protocol-mismatch"; serverProtocolVersion: number | undefined };

export type NoticeHost = "browser" | "desktop";

interface NoticeContent {
  heading: string;
  cause: string;
  hint?: string | undefined;
  status?: string | undefined;
  instruction?: string | undefined;
  field: boolean;
}

/** The #/<current route>?capability=… form `resolveServerTarget` reads on the next load. */
export function hashWithCapability(hash: string, capability: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryAt = raw.indexOf("?");
  const route = (queryAt === -1 ? raw : raw.slice(0, queryAt)) || "/";
  const params = new URLSearchParams(queryAt === -1 ? "" : raw.slice(queryAt + 1));
  params.set(CAPABILITY_HASH_PARAM, capability);
  return `#${route.startsWith("/") ? route : `/${route}`}?${params.toString()}`;
}

/** Writes a capability where the bootstrap will read it, without adding a history entry. */
export function putCapabilityInHash(capability: string): void {
  const hash = hashWithCapability(window.location.hash, capability);
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${hash}`,
  );
}

function isDesktop(): boolean {
  return typeof window !== "undefined" && window.corral !== undefined;
}

/** The capability field, shared by the boot notice and the running recovery dialog. */
export function CapabilityForm({
  onSubmit,
  hint,
  submitLabel = "Use capability",
  autoFocus = true,
}: {
  onSubmit: (capability: string) => void;
  hint?: string | undefined;
  submitLabel?: string;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        const capability = value.trim();
        if (capability === "") return;
        if (!isCapabilityToken(capability)) {
          setError(
            "That is not a valid capability: paste the token from endpoint.json (no spaces or line breaks).",
          );
          return;
        }
        setError(undefined);
        onSubmit(capability);
      }}
    >
      <FormField label="Capability">
        <Input
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setError(undefined);
          }}
          aria-invalid={error !== undefined}
          placeholder="Paste the capability from endpoint.json"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
        />
      </FormField>
      {error !== undefined && (
        <p className="m-0 text-xs leading-relaxed text-destructive" role="alert">
          {error}
        </p>
      )}
      {hint !== undefined && (
        <p className="m-0 text-xs leading-relaxed text-muted-foreground">{hint}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={value.trim() === ""}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

function formatElapsed(now: number, startedAt: number): string {
  return `${Math.max(0, Math.floor((now - startedAt) / 1000))} s`;
}

function bootContent(failure: ServerTargetFailure | undefined, message: string): NoticeContent {
  switch (failure?.kind) {
    case "no-capability":
      return {
        heading: "No server capability",
        cause: "This page opened without the capability it needs to reach a Corral server.",
        hint: "Open the page with #/<route>?capability=… or paste the capability from endpoint.json below. It stays in this tab and is never sent to another server.",
        field: true,
      };
    case "empty-capability":
      return {
        heading: "The server capability is empty",
        cause: "The address named a capability, but its value was empty.",
        hint: "Paste the capability Corral published in endpoint.json below.",
        field: true,
      };
    case "other-server":
      return {
        heading: "The saved capability belongs to another server",
        cause: `The saved capability belongs to ${failure.storedUrl}, not ${failure.url}.`,
        hint: "Paste the capability for the server this page points at, or open that server's URL with its own capability.",
        field: true,
      };
    case "invalid-url":
      return {
        heading: "The server address is not valid",
        cause: `Corral can only connect to a ws:// or wss:// address, not "${failure.given ?? "the one in this page's URL"}".`,
        hint: "Fix ?server= in this page's address, then reload. A capability cannot repair an invalid address.",
        field: false,
      };
    case "invalid-capability":
      return {
        heading: "That capability cannot be used",
        cause:
          "The capability is not a valid WebSocket token. Corral did not store it or open a socket.",
        hint: "Paste the capability Corral published in endpoint.json below.",
        field: true,
      };
    case "desktop-endpoint":
      return {
        heading: "The desktop app did not provide a server endpoint",
        cause: message,
        hint: "Quit and reopen the app.",
        field: false,
      };
    default:
      return {
        heading: "Corral cannot start",
        cause: message,
        field: false,
      };
  }
}

function describeProblem(problem: NoticeProblem, host: NoticeHost, now: number): NoticeContent {
  switch (problem.kind) {
    case "boot":
      return bootContent(problem.failure, problem.message);
    case "connecting":
      return {
        heading: "Connecting to the server",
        cause: `Corral is opening a connection to ${problem.serverUrl ?? "the server"}.`,
        status: `Attempt ${problem.attempt} · ${formatElapsed(now, problem.startedAt)}`,
        field: host === "browser",
      };
    case "unreachable":
      return {
        heading: "Cannot reach the server",
        cause: `Corral could not open a connection to ${problem.serverUrl ?? "the server"}.`,
        status: `Attempt ${problem.attempt} · ${formatElapsed(now, problem.startedAt)}`,
        hint:
          host === "browser"
            ? "If the server restarted, paste the capability it published in endpoint.json, or retry."
            : undefined,
        field: host === "browser",
      };
    case "capability-refused":
      return {
        heading: "The server refused this capability",
        cause: `The server${problem.serverUrl === undefined ? "" : ` at ${problem.serverUrl}`} did not accept this page's capability.`,
        status: `Attempt ${problem.attempt} · ${formatElapsed(now, problem.startedAt)}`,
        hint:
          host === "browser"
            ? "Paste the capability the server published in endpoint.json. Recovery also reattaches the open terminals."
            : "Stop that server and start the app again. It was left running, so its sessions are untouched.",
        field: host === "browser",
      };
    case "invalid-capability":
      return {
        heading: "That capability cannot be used",
        cause:
          problem.detail ??
          "The capability is not a valid WebSocket token. Corral did not open a socket.",
        hint:
          host === "browser"
            ? "Paste the capability Corral published in endpoint.json. The previous target is kept until a valid one is supplied."
            : "Stop that server and start the app again. It was left running, so its sessions are untouched.",
        field: host === "browser",
      };
    case "protocol-mismatch":
      return {
        heading: "This app and the server cannot talk to each other",
        cause: `The server speaks protocol version ${problem.serverProtocolVersion ?? "unknown"}; this app speaks version ${PROTOCOL_VERSION}.`,
        hint:
          host === "browser"
            ? "Update Corral or the server so both speak the same version, then reload."
            : undefined,
        instruction:
          host === "desktop"
            ? "Stop that server and start the app again. It was left running, so its sessions are untouched."
            : undefined,
        field: false,
      };
    default:
      return {
        heading: "Corral cannot use the server",
        cause: "The connection state is unknown.",
        field: false,
      };
  }
}

export function StartupNotice({
  problem,
  host = isDesktop() ? "desktop" : "browser",
  onReload,
  onRetry,
  onUseCapability,
}: {
  problem: NoticeProblem;
  host?: NoticeHost;
  onReload?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
  onUseCapability?: ((capability: string) => void) | undefined;
}) {
  const now = useNow(1000);
  const content = describeProblem(problem, host, now);
  const reload =
    (problem.kind === "boot" || (problem.kind === "protocol-mismatch" && host === "browser")) &&
    onReload !== undefined;
  const retry =
    onRetry !== undefined &&
    (problem.kind === "unreachable" ||
      problem.kind === "connecting" ||
      (problem.kind === "capability-refused" && host === "desktop"));
  return (
    <div className="flex h-full min-h-0 items-start justify-center overflow-y-auto p-6 sm:items-center">
      <ContentLane className="gap-4 rounded-xl border border-border bg-card p-6">
        <div className="flex flex-col gap-1">
          <p className="m-0 text-xs font-medium text-muted-foreground">Corral</p>
          <h1 className="m-0 text-base font-semibold">{content.heading}</h1>
          <p className="m-0 text-sm leading-relaxed text-muted-foreground" role="alert">
            {content.cause}
          </p>
          {content.status !== undefined && (
            <p className="m-0 text-xs text-muted-foreground" role="status">
              {content.status}
            </p>
          )}
        </div>
        {content.field && onUseCapability !== undefined && (
          <CapabilityForm onSubmit={onUseCapability} hint={content.hint} />
        )}
        {content.hint !== undefined && !content.field && (
          <p className="m-0 text-sm leading-relaxed text-muted-foreground">{content.hint}</p>
        )}
        {content.instruction !== undefined && (
          <p className="m-0 text-sm font-medium">{content.instruction}</p>
        )}
        {(reload || retry) && (
          <div className="flex flex-wrap gap-2">
            {retry && (
              <Button variant="outline" onClick={onRetry}>
                Retry now
              </Button>
            )}
            {reload && (
              <Button variant="outline" onClick={onReload}>
                Reload
              </Button>
            )}
          </div>
        )}
      </ContentLane>
    </div>
  );
}

/** The protocol mismatch notice, the one state that never reaches the workspace. */
export function ProtocolMismatchNotice({
  serverProtocolVersion,
}: {
  serverProtocolVersion: number | undefined;
}) {
  return (
    <StartupNotice
      problem={{ kind: "protocol-mismatch", serverProtocolVersion }}
      onReload={() => window.location.reload()}
    />
  );
}

const RECOVERY_PROBLEM = (connection: ConnectionState, serverUrl: string): NoticeProblem => {
  if (connection.status === "connecting") {
    return {
      kind: "connecting",
      attempt: connection.attempt,
      startedAt: connection.startedAt,
      serverUrl,
    };
  }
  if (connection.status === "capability-refused") {
    return {
      kind: "capability-refused",
      attempt: connection.attempt,
      startedAt: connection.startedAt,
      serverUrl,
    };
  }
  if (connection.status === "invalid-capability") {
    return { kind: "invalid-capability", detail: connection.detail, serverUrl };
  }
  return {
    kind: "unreachable",
    attempt: "attempt" in connection ? connection.attempt : 0,
    startedAt: "startedAt" in connection ? connection.startedAt : Date.now(),
    serverUrl,
  };
};

/** The same capability field as a dialog over a running workspace (`docs/ux.md`). */
export function ConnectionRecoveryDialog({ onClose }: { onClose: () => void }) {
  const client = useCorralClient();
  const connection = useConnection();
  const now = useNow(1000);
  useEffect(() => {
    if (connection.status === "connected") onClose();
  }, [connection.status, onClose]);
  const host: NoticeHost = isDesktop() ? "desktop" : "browser";
  const problem = RECOVERY_PROBLEM(connection, client.server.url);
  const content = describeProblem(problem, host, now);
  const retry = host === "desktop" || problem.kind === "unreachable";
  return (
    <TaskDialog title={content.heading} description={content.cause} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {content.status !== undefined && (
          <p className="m-0 text-xs text-muted-foreground" role="status">
            {content.status}
          </p>
        )}
        {content.hint !== undefined && !content.field && (
          <p className="m-0 text-sm leading-relaxed text-muted-foreground">{content.hint}</p>
        )}
        {content.instruction !== undefined && (
          <p className="m-0 text-sm font-medium">{content.instruction}</p>
        )}
        {content.field && (
          <CapabilityForm
            onSubmit={(capability) => {
              putCapabilityInHash(capability);
              client.recover();
            }}
            hint={content.hint}
            submitLabel="Reconnect"
          />
        )}
        {retry && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => client.recover()}>
              Retry now
            </Button>
          </div>
        )}
      </div>
    </TaskDialog>
  );
}
