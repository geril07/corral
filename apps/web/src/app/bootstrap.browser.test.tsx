import { resolveServerTarget, type ServerTargetStorage } from "@corral/client/bootstrap";
import { capabilityProtocols, protocolUrl } from "@corral/protocol/handshake";
import { RPC_PATH } from "@corral/protocol/rpc";
import type { ServerTarget } from "@corral/protocol/server-target";
import { expect, test } from "vite-plus/test";
import { realServerClients } from "../../test/real-client.ts";
import { serverTarget } from "../../test/server-url.ts";

const DEADLINE_MS = 10_000;
const SENTINEL = "BROWSER_BOOTSTRAP_SENTINEL_6c1d";
const { newClient } = realServerClients();

function opened(socket: WebSocket): Promise<"open" | "refused"> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("timed out waiting for the websocket handshake"));
    }, DEADLINE_MS);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve("open");
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        resolve("refused");
      },
      { once: true },
    );
    socket.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve("refused");
      },
      { once: true },
    );
  });
}

test("a page from another origin cannot open a socket without the capability", async () => {
  const target = serverTarget();
  const url = protocolUrl(target.url, RPC_PATH);

  const without = new WebSocket(url);
  expect(await opened(without)).toBe("refused");

  const wrong = new WebSocket(url, capabilityProtocols("not-the-capability"));
  expect(await opened(wrong)).toBe("refused");

  const trusted = new WebSocket(url, capabilityProtocols(target.capability));
  expect(await opened(trusted)).toBe("open");
  trusted.close();
});

function memoryStorage(initial?: ServerTarget): ServerTargetStorage & {
  value: ServerTarget | undefined;
} {
  const store = {
    value: initial,
    read: () => store.value,
    write: (target: ServerTarget) => {
      store.value = target;
    },
  };
  return store;
}

function replacePage(searchAndHash: string) {
  window.history.replaceState(null, "", `${window.location.pathname}${searchAndHash}`);
}

function applyRouteHash(hash: string) {
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${hash}`,
  );
}

test("a capability in the hash survives reloads, keeps the route and connects both channels", async () => {
  const target = serverTarget();
  const original = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const storage = memoryStorage();
  try {
    replacePage(
      `?server=${encodeURIComponent(target.url)}#/tasks/abc?entry=e1&capability=${encodeURIComponent(target.capability)}`,
    );

    const resolved = await resolveServerTarget({
      location: window.location,
      storage,
      applyHash: applyRouteHash,
    });

    expect(resolved).toEqual(target);
    expect(storage.value).toEqual(target);
    expect(window.location.hash).toBe("#/tasks/abc?entry=e1");

    // A reload (same tab) keeps ?server= but has no capability in the URL, only the stored pair.
    replacePage(`?server=${encodeURIComponent(target.url)}#/tasks/abc?entry=e1`);
    const reloaded = await resolveServerTarget({
      location: window.location,
      storage,
      applyHash: applyRouteHash,
    });
    expect(reloaded).toEqual(target);
    expect(window.location.hash).toBe("#/tasks/abc?entry=e1");

    const client = newClient(reloaded);
    await expect.poll(() => client.connection.state.getSnapshot().status).toBe("connected");
    let output = "";
    const surface = {
      write(data: string | Uint8Array, callback?: () => void) {
        output += typeof data === "string" ? data : new TextDecoder().decode(data);
        callback?.();
      },
      reset() {},
      resize() {},
    };
    const info = await client.connection.api.terminals.create({
      command: "/bin/sh",
      args: ["-c", `printf '${SENTINEL}\\n'; read x`],
      size: { cols: 80, rows: 24 },
    });
    const stream = client.attach(info.id, surface);
    try {
      await expect.poll(() => output).toContain(SENTINEL);
    } finally {
      stream.close();
    }
  } finally {
    window.history.replaceState(null, "", original);
  }
});

test("a stored capability is never sent to a different ?server= host", async () => {
  const target = serverTarget();
  const original = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const storage = memoryStorage(target);
  try {
    replacePage(`?server=${encodeURIComponent("ws://evil.example")}#/board`);

    await expect(resolveServerTarget({ location: window.location, storage })).rejects.toThrow(
      "belongs to",
    );
    expect(storage.value).toEqual(target);
  } finally {
    window.history.replaceState(null, "", original);
  }
});
