import type { ModelCatalogInput } from "@corral/protocol/models";
import { modelKey, modelVisible, orderModels } from "@corral/protocol/models";
import { useModelCatalog, useModelPreferences, type KnownModelCatalog } from "./model-catalog.ts";

/** One visibility projection for creation, add-agent and live chat. Current selection is not written. */
export function useModelMenu(input: ModelCatalogInput, known?: KnownModelCatalog) {
  const preferences = useModelPreferences(input.scope);
  const inventory = useModelCatalog(input, true, known);
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
  };
}
