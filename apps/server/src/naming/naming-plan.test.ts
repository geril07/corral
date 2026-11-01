import type { LaunchProfile, NamingSettings } from "@corral/protocol/config";
import { defaultNamingSettings } from "@corral/protocol/config";
import { expect, test, vi } from "vite-plus/test";
import { namingPlan, type NamingSettingsSource } from "./naming.ts";

const profile: LaunchProfile = {
  id: "gateway",
  name: "Claude via gateway",
  agent: "claude",
  model: "claude-sonnet-4-5",
  provider: null,
  env: [{ targetName: "ANTHROPIC_AUTH_TOKEN", fromEnv: "TOKEN" }],
  revision: "0123456789ab",
};

const settings = (overrides: Partial<NamingSettings> = {}): NamingSettings => ({
  ...defaultNamingSettings(),
  ...overrides,
});

const source = (naming: NamingSettings, profiles: LaunchProfile[] = []): NamingSettingsSource => ({
  settings: () => naming,
  profiles: () => profiles,
});

test("empty [naming] runs nothing", () => {
  expect(namingPlan(source(settings()), { generatedSlug: false })).toBeUndefined();
});

test("a profile supplies agent, model and environment; the section's model wins", () => {
  expect(
    namingPlan(
      source(
        settings({
          profile: { value: "gateway", source: "global" },
          model: { value: "claude-haiku-4-5", source: "global" },
          timeoutSeconds: { value: 3, source: "global" },
        }),
        [profile],
      ),
      { generatedSlug: true },
    ),
  ).toEqual({
    launch: { kind: "claude", model: "claude-haiku-4-5", provider: null },
    command: "claude",
    env: profile.env,
    profileId: "gateway",
    timeoutMs: 3000,
    generatedSlug: true,
  });
});

test("an agent alone runs with the default timeout and no model", () => {
  expect(
    namingPlan(source(settings({ agent: { value: "pi", source: "global" } })), {
      generatedSlug: false,
    }),
  ).toMatchObject({
    launch: { kind: "pi", model: null, provider: null },
    env: [],
    profileId: null,
    timeoutMs: 8000,
  });
});

test("a profile the config no longer has runs nothing and says why", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  expect(
    namingPlan(source(settings({ profile: { value: "gone", source: "global" } })), {
      generatedSlug: false,
    }),
  ).toBeUndefined();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("no usable launch profile: gone"));
  warn.mockRestore();
});

test("opencode is refused, since it cannot run without saving a session", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  expect(
    namingPlan(source(settings({ agent: { value: "opencode", source: "global" } })), {
      generatedSlug: false,
    }),
  ).toBeUndefined();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("opencode cannot run"));
  warn.mockRestore();
});
