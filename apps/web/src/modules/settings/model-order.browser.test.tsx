import type { CorralClient } from "@corral/client/corral-client";
import { defaultModelPolicy, modelScopeKey } from "@corral/protocol/models";
import { useSyncExternalStore } from "react";
import { expect, test } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { realServerClients } from "../../../test/real-client.ts";
import { CorralClientProvider } from "../connection/index.ts";
import { KeymapProvider } from "../keymap/index.ts";
import { ModelManagement } from "./model-management.tsx";

const { newClient } = realServerClients();
const scope = { kind: "pi" as const, profileId: null };
const catalog = [
  { provider: "one", id: "a", name: "Alpha" },
  { provider: "one", id: "b", name: "Beta" },
  { provider: "two", id: "c", name: "Gamma" },
];
const noop = () => {};

function Manager({ client }: { client: CorralClient }) {
  const config = useSyncExternalStore(client.config.subscribe, client.config.getSnapshot);
  return (
    <CorralClientProvider client={client}>
      <KeymapProvider config={config}>
        <ModelManagement
          active
          target={{ scope, context: {}, known: { scope, context: {}, models: catalog } }}
          onDirty={noop}
          onBusy={noop}
        />
      </KeymapProvider>
    </CorralClientProvider>
  );
}

function rowOrder(): string[] {
  const list = document.querySelector('[aria-label="Catalog models"]');
  return [...(list?.querySelectorAll(':scope > [role="group"]') ?? [])].map(
    (row) => row.getAttribute("aria-label") ?? "",
  );
}

test("Settings saves independent provider, model and favorite order to the shared config", async () => {
  const client = newClient();
  await render(<Manager client={client} />);
  const moveProvider = page.getByRole("button", { name: "Move provider two up", exact: true });
  await expect.element(moveProvider).toBeEnabled();
  await moveProvider.click();
  await page.getByRole("button", { name: "Move model Beta · one up", exact: true }).click();
  expect(rowOrder()).toEqual(["Gamma · two", "Beta · one", "Alpha · one"]);

  await page.getByRole("button", { name: "Favorite Alpha · one", exact: true }).click();
  await page.getByRole("button", { name: "Favorite Gamma · two", exact: true }).click();
  await page.getByRole("combobox", { name: "Model rows", exact: true }).click();
  await page.getByRole("option", { name: "favorites", exact: true }).click();
  expect(rowOrder()).toEqual(["Alpha · one", "Gamma · two"]);
  await page.getByRole("button", { name: "Move favorite Gamma · two up", exact: true }).click();
  expect(rowOrder()).toEqual(["Gamma · two", "Alpha · one"]);

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .element(page.getByRole("status").filter({ hasText: "Saved · revision" }))
    .toBeVisible();
  const saved = client.modelPreferences
    .getSnapshot()
    .items.find((item) => modelScopeKey(item.scope) === modelScopeKey(scope));
  expect(saved?.policy).toMatchObject({
    providerOrder: ["two", "one"],
    modelOrder: [
      { provider: "one", id: "b" },
      { provider: "one", id: "a" },
    ],
    favorites: [
      { provider: "two", id: "c" },
      { provider: "one", id: "a" },
    ],
  });
});

test("an idle Settings editor accepts changed content even when its opaque revision decreases", async () => {
  const client = newClient();
  await expect.poll(() => client.modelPreferences.getSnapshot().loaded).toBe(true);
  const api = client.connection.api;
  const current = client.modelPreferences
    .getSnapshot()
    .items.find((item) => modelScopeKey(item.scope) === modelScopeKey(scope));
  const first = await api.models.save({
    scope,
    revision: current?.revision ?? 0,
    policy: defaultModelPolicy(),
  });
  const second = await api.models.save({
    ...first,
    policy: { ...defaultModelPolicy(), deny: [{ type: "provider", provider: "one" }] },
  });
  const [higher, lower] = first.revision > second.revision ? [first, second] : [second, first];
  const active = await api.models.save({ ...higher, revision: second.revision });
  await render(<Manager client={client} />);
  const alpha = page.getByRole("checkbox", { name: "Show Alpha · one", exact: true });
  await expect.element(alpha).toBeVisible();
  await api.models.save({ ...lower, revision: active.revision });
  await expect
    .element(alpha)
    .toHaveAttribute("aria-checked", lower.policy.deny.length === 0 ? "true" : "false");
  await expect
    .element(page.getByRole("status").filter({ hasText: `Saved · revision ${lower.revision}` }))
    .toBeVisible();
  await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
});
