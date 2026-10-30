import { resolveServerTarget } from "@corral/client/bootstrap";
import { capabilityProtocols, protocolUrl } from "@corral/protocol/handshake";
import { RPC_PATH } from "@corral/protocol/rpc";
import { expect, test } from "vite-plus/test";
import { serverTarget } from "../../test/server-url.ts";

const DEADLINE_MS = 10_000;

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

test("a capability in the hash survives reloads without breaking the route", async () => {
  const original = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const stored: { value?: string } = {};
  try {
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}?server=${encodeURIComponent(serverTarget().url)}#/tasks/abc?entry=e1&capability=from-hash`,
    );

    const resolved = await resolveServerTarget({
      location: window.location,
      storage: {
        read: () => stored.value,
        write: (capability) => {
          stored.value = capability;
        },
      },
      applyHash: (hash) =>
        window.history.replaceState(null, "", `${window.location.pathname}${hash}`),
    });

    expect(resolved.capability).toBe("from-hash");
    expect(stored.value).toBe("from-hash");
    expect(window.location.hash).toBe("#/tasks/abc?entry=e1");

    // A reload (same tab) has no capability in the URL, only the stored one.
    window.history.replaceState(null, "", `${window.location.pathname}#/tasks/abc?entry=e1`);
    const reloaded = await resolveServerTarget({
      location: window.location,
      storage: {
        read: () => stored.value,
        write: (capability) => {
          stored.value = capability;
        },
      },
      applyHash: (hash) =>
        window.history.replaceState(null, "", `${window.location.pathname}${hash}`),
    });
    expect(reloaded.capability).toBe("from-hash");
    expect(window.location.hash).toBe("#/tasks/abc?entry=e1");
  } finally {
    window.history.replaceState(null, "", original);
  }
});
