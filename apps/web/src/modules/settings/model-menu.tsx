import type { ModelCatalogInput } from "@corral/protocol/models";
import { modelKey, modelVisible, orderModels } from "@corral/protocol/models";
import { useState } from "react";
import { Button } from "../../common/ui/index.ts";
import { useModelCatalog, useModelPreferences, type KnownModelCatalog } from "./model-catalog.ts";
import { SettingsScreen } from "./settings-screen.tsx";

/** One visibility projection for creation, add-agent and live chat. Current selection is not written. */
export function useModelMenu(input: ModelCatalogInput, known?: KnownModelCatalog) {
  const preferences = useModelPreferences(input.scope);
  const [managing, setManaging] = useState(false);
  const [returned, setReturned] = useState(false);
  const inventory = useModelCatalog(input, !managing, known);
  const all = inventory.catalog?.models ?? [];
  const favorite = (model: { provider: string | null; id: string }) =>
    preferences.policy.favorites.some((f) => modelKey(f) === modelKey(model));
  const models = preferences.loaded
    ? orderModels(
        preferences.policy,
        all.filter((model) => modelVisible(preferences.policy, model)),
      )
    : [];
  return {
    ...inventory,
    all,
    models,
    preferences,
    favorite,
    managing,
    returned,
    footer: (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {!preferences.loaded
            ? "Loading model preferences…"
            : inventory.loading
              ? "Loading models…"
              : `Visible ${models.length} of ${all.length}`}
        </span>
        <Button size="sm" variant="ghost" onClick={() => setManaging(true)}>
          Manage models…
        </Button>
      </div>
    ),
    settings: managing ? (
      <SettingsScreen
        modelTarget={{ scope: input.scope, context: input.context, ...(known ? { known } : {}) }}
        onClose={() => {
          setManaging(false);
          setReturned(true);
        }}
      />
    ) : null,
  };
}
