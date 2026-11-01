import type { ChatModelRef } from "@corral/protocol/chat";

/**
 * The picker value of a model: its provider and id, because pi's ids are only unique within a
 * provider. A provider id cannot contain `/`, so the pair round-trips.
 */
export function chatModelKey(model: ChatModelRef): string {
  return `${model.provider ?? ""}/${model.id}`;
}
