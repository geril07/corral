import type { ServerTarget } from "@corral/protocol/server-target";
import { describe, expect, test } from "vite-plus/test";
import {
  CAPABILITY_STORAGE_KEY,
  resolveServerTarget,
  type CapabilityStorage,
} from "./bootstrap.ts";

function memoryStorage(initial?: string): CapabilityStorage & { value: string | undefined } {
  const store = {
    value: initial,
    read: () => store.value,
    write: (capability: string) => {
      store.value = capability;
    },
  };
  return store;
}

const page = { search: "", protocol: "http:", host: "127.0.0.1:5173", hash: "#/" };

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
        storage: memoryStorage("stale"),
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
    expect(storage.value).toBe("from-hash");
    expect(applied).toBe("#/tasks/abc?entry=e1");
  });

  test("a reload with a normal hash route uses the stored capability", async () => {
    const storage = memoryStorage("stored");
    let applied = "";

    const resolved = await resolveServerTarget({
      location: { ...page, hash: "#/board?task=t1" },
      storage,
      applyHash: (hash) => {
        applied = hash;
      },
    });

    expect(resolved.capability).toBe("stored");
    expect(applied).toBe("");
    expect(storage.value).toBe("stored");
  });

  test("the ?server= URL still selects another server, without carrying the capability", async () => {
    const resolved = await resolveServerTarget({
      location: {
        ...page,
        search: "?server=ws%3A%2F%2F127.0.0.1%3A4200",
        hash: "#/",
      },
      storage: memoryStorage("stored"),
    });

    expect(resolved).toEqual({ url: "ws://127.0.0.1:4200", capability: "stored" });
  });

  test("no capability anywhere fails clearly instead of opening an unauthenticated socket", async () => {
    await expect(resolveServerTarget({ location: page, storage: memoryStorage() })).rejects.toThrow(
      "No server capability",
    );
  });

  test("the storage key is stable across reloads in one tab", () => {
    expect(CAPABILITY_STORAGE_KEY).toBe("corral.capability");
  });
});
