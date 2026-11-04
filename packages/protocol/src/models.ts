import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { ChatModel, ChatModelRef, type ChatModelRef as ModelRef } from "./chat.ts";
import { AgentKind } from "./config.ts";

export const ModelScope = z.object({
  kind: AgentKind,
  profileId: z.string().min(1).max(128).nullable(),
});
export type ModelScope = z.infer<typeof ModelScope>;

/** Stable across profile revisions and names; never shared between agent kinds. */
export function modelScopeKey(scope: ModelScope): string {
  return JSON.stringify({ kind: scope.kind, profileId: scope.profileId });
}
export function modelKey(model: ModelRef): string {
  return JSON.stringify([model.provider, model.id]);
}

export const ModelRule = z.discriminatedUnion("type", [
  z.object({ type: z.literal("provider"), provider: z.string().min(1).max(512) }),
  z.object({
    type: z.literal("model"),
    provider: z.string().nullable(),
    id: z.string().min(1).max(512),
  }),
]);
export type ModelRule = z.infer<typeof ModelRule>;
export const ModelPolicy = z.object({
  mode: z.enum(["all", "allow"]),
  allow: z.array(ModelRule).max(10000),
  deny: z.array(ModelRule).max(10000),
  favorites: z.array(ChatModelRef).max(10000),
});
export type ModelPolicy = z.infer<typeof ModelPolicy>;
export const ModelPreferences = z.object({
  scope: ModelScope,
  revision: z.number().int().nonnegative(),
  policy: ModelPolicy,
});
export type ModelPreferences = z.infer<typeof ModelPreferences>;

export function defaultModelPolicy(): ModelPolicy {
  return { mode: "all", allow: [], deny: [], favorites: [] };
}
export function matchesModel(rule: ModelRule, model: ModelRef): boolean {
  return rule.provider === model.provider && (rule.type === "provider" || rule.id === model.id);
}
export function modelVisible(policy: ModelPolicy, model: ModelRef): boolean {
  return (
    !policy.deny.some((rule) => matchesModel(rule, model)) &&
    (policy.mode === "all" || policy.allow.some((rule) => matchesModel(rule, model)))
  );
}
export function providerDenied(policy: ModelPolicy, provider: string | null): boolean {
  return policy.deny.some((rule) => rule.type === "provider" && rule.provider === provider);
}
export function setModelVisible(
  policy: ModelPolicy,
  model: ModelRef,
  visible: boolean,
): ModelPolicy {
  const exact = (rule: ModelRule) => rule.type === "model" && matchesModel(rule, model);
  const rule: ModelRule = { type: "model", provider: model.provider, id: model.id };
  return {
    ...policy,
    allow:
      visible && policy.mode === "allow" && !policy.allow.some((r) => matchesModel(r, model))
        ? [...policy.allow, rule]
        : policy.allow,
    deny: visible
      ? policy.deny.filter((r) => !exact(r))
      : [...policy.deny.filter((r) => !exact(r)), rule],
  };
}
export function setProviderVisible(
  policy: ModelPolicy,
  provider: string,
  visible: boolean,
): ModelPolicy {
  return {
    ...policy,
    allow:
      visible &&
      policy.mode === "allow" &&
      !policy.allow.some((r) => r.type === "provider" && r.provider === provider)
        ? [...policy.allow, { type: "provider", provider }]
        : policy.allow,
    deny: visible
      ? policy.deny.filter((r) => r.provider !== provider)
      : [
          ...policy.deny.filter((r) => !(r.type === "provider" && r.provider === provider)),
          { type: "provider", provider },
        ],
  };
}
export function toggleModelFavorite(policy: ModelPolicy, model: ModelRef): ModelPolicy {
  const key = modelKey(model);
  return {
    ...policy,
    favorites: policy.favorites.some((m) => modelKey(m) === key)
      ? policy.favorites.filter((m) => modelKey(m) !== key)
      : [...policy.favorites, { provider: model.provider, id: model.id }],
  };
}

/** No client-supplied filesystem path or environment; context names an existing project/task. */
export const ModelContext = z.object({
  projectId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
});
export type ModelContext = z.infer<typeof ModelContext>;
export const ModelCatalogInput = z.object({
  scope: ModelScope,
  context: ModelContext,
  expectedProfileRevision: z.string().optional(),
  refresh: z.boolean().optional(),
});
export type ModelCatalogInput = z.infer<typeof ModelCatalogInput>;
export const ModelCatalog = z.object({
  models: z.array(ChatModel),
  status: z.enum(["ready", "partial", "stale", "error", "unsupported"]),
  fetchedAt: z.number().nullable(),
  message: z.string().nullable(),
});
export type ModelCatalog = z.infer<typeof ModelCatalog>;

export const modelsContract = {
  watch: oc.output(eventIterator(z.array(ModelPreferences))),
  save: oc
    .input(ModelPreferences)
    .output(ModelPreferences)
    .errors({
      MODEL_PREFERENCES_CHANGED: { status: 409 },
    }),
  catalog: oc.input(ModelCatalogInput).output(ModelCatalog),
};
