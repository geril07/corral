import type { ServerTarget } from "@corral/protocol/server-target";
import { describe, expect, test } from "vite-plus/test";
import {
  resolveServerTarget,
  SERVER_TARGET_STORAGE_KEY,
  type ServerTargetStorage,
} from "./bootstrap.ts";

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

const page = { search: "", protocol: "http:", host: "127.0.0.1:5173", hash: "#/" };
const sameServer = { url: "ws://127.0.0.1:5173", capability: "stored" };

describe("desktop bridge", () => {
  test("takes the endpoint from the shell and never from the page URL", async () => {
    const target: ServerTarget = { url: "ws://127.0.0.1:4100", capability: "from-endpoint" };
    const storage = memoryStorage();

    const resolved = await resolveServerTarget({
      location: { ...page, search: "?server=ws%3A%2F%2Fevil", hash: "#/board" },
      bridge: { server: async () => target },
      storage,
    });

    expect(resolved).toEqual(target);
    expect(storage.value).toBeUndefined();
  });

  test("a bridge without a server fails instead of falling back to an unauthenticated URL", async () => {
    await expect(
      resolveServerTarget({
        location: page,
        bridge: { server: async () => null },
        storage: memoryStorage(sameServer),
      }),
    ).rejects.toThrow("did not provide");
  });
});

describe("browser bootstrap", () => {
  test("takes the capability from the hash route, keeps the route and strips only the capability", async () => {
    const storage = memoryStorage();
    let applied = "";

    const resolved = await resolveServerTarget({
      location: { ...page, hash: "#/tasks/abc?entry=e1&capability=from-hash" },
      storage,
      applyHash: (hash) => {
        applied = hash;
      },
    });

    expect(resolved).toEqual({
      url: "ws://127.0.0.1:5173",
      capability: "from-hash",
    });
    expect(storage.value).toEqual(resolved);
    expect(applied).toBe("#/tasks/abc?entry=e1");
  });

  test("a reload with a normal hash route reuses the stored URL and capability", async () => {
    const storage = memoryStorage(sameServer);
    let applied = "";

    const resolved = await resolveServerTarget({
      location: { ...page, hash: "#/board?task=t1" },
      storage,
      applyHash: (hash) => {
        applied = hash;
      },
    });

    expect(resolved).toEqual(sameServer);
    expect(applied).toBe("");
    expect(storage.value).toEqual(sameServer);
  });

  test("a stored capability is never offered to a different ?server= URL", async () => {
    const storage = memoryStorage(sameServer);

    await expect(
      resolveServerTarget({
        location: {
          ...page,
          search: "?server=ws%3A%2F%2Fevil.example",
          hash: "#/board",
        },
        storage,
      }),
    ).rejects.toThrow("belongs to ws://127.0.0.1:5173, not ws://evil.example");
    expect(storage.value).toEqual(sameServer);
  });

  test("an explicit hash bootstrap can switch servers and replaces the stored pair", async () => {
    const storage = memoryStorage(sameServer);
    let applied = "";

    const resolved = await resolveServerTarget({
      location: {
        ...page,
        search: "?server=ws%3A%2F%2F127.0.0.1%3A4200",
        hash: "#/tasks/abc?capability=new-server",
      },
      storage,
      applyHash: (hash) => {
        applied = hash;
      },
    });

    expect(resolved).toEqual({ url: "ws://127.0.0.1:4200", capability: "new-server" });
    expect(storage.value).toEqual(resolved);
    expect(applied).toBe("#/tasks/abc");
  });

  test("no capability anywhere fails clearly instead of opening an unauthenticated socket", async () => {
    await expect(resolveServerTarget({ location: page, storage: memoryStorage() })).rejects.toThrow(
      "No server capability",
    );
  });

  test("an empty capability in the hash is refused instead of falling back", async () => {
    await expect(
      resolveServerTarget({
        location: { ...page, hash: "#/?capability=" },
        storage: memoryStorage(sameServer),
      }),
    ).rejects.toThrow("capability in the URL is empty");
  });

  test("the storage key is stable and holds a target pair, not a bare token", () => {
    expect(SERVER_TARGET_STORAGE_KEY).toBe("corral.server-target");
  });
});
