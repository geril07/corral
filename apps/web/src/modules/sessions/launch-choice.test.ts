import {
  AGENT_LAUNCH_CAPABILITY,
  defaultClientConfig,
  type LaunchProfile,
} from "@corral/protocol/config";
import type { ChatModel } from "@corral/protocol/chat";
import { AgentKind } from "@corral/protocol/rpc";
import { expect, test } from "vite-plus/test";
import {
  CONFIGURED_DEFAULT,
  configuredDefaultRow,
  defaultLaunch,
  launchCatalogRow,
  launchChoice,
  launchKey,
  launchOptions,
  launchProblem,
  launchView,
  modelOverride,
  modelProblem,
  supportsModel,
} from "./launch-choice.ts";

const config = defaultClientConfig("/data");
const gateway: LaunchProfile = {
  id: "gateway",
  revision: "3",
  name: "Gateway",
  agent: "claude",
  model: "claude-sonnet-4-5",
  provider: null,
  env: [],
};
const stubOne: ChatModel = { provider: "stub", id: "stub-1", name: "Stub One" };
const stubTwo: ChatModel = { provider: "stub", id: "stub-2", name: "Stub Two" };
const piStub: LaunchProfile = {
  ...gateway,
  id: "pi-stub",
  name: "Pi Stub",
  agent: "pi",
  model: "stub-1",
};

test("the picker hides a model field exactly where the shared capability table does", () => {
  for (const kind of AgentKind.options)
    expect(supportsModel(kind)).toBe(AGENT_LAUNCH_CAPABILITY[kind].model);
  expect(supportsModel("opencode")).toBe(false);
});

test("an empty field is no override; spaces alone are not a model", () => {
  expect(modelOverride("")).toBeUndefined();
  expect(modelOverride("   ")).toBeUndefined();
  expect(modelOverride("  gpt-5-codex ")).toBe("gpt-5-codex");
});

test("the documented native model shape is accepted and a chat name is not", () => {
  for (const valid of ["claude-sonnet-4-5", "anthropic/claude-sonnet-4:high", "gpt-5-codex", "a"])
    expect(modelProblem("pi", valid)).toBeUndefined();
  expect(modelProblem("claude", "claude sonnet")).toContain("native model id");
  expect(modelProblem("claude", "/leading")).toContain("native model id");
  expect(modelProblem("opencode", "anything")).toBeUndefined();
});

test("configured profiles win, model overrides stay explicit and payloads pin the displayed revision", () => {
  const settings = {
    ...config.tasks,
    agent: { value: "codex" as const, source: "global" as const },
    profile: { value: "gateway", source: "global" as const },
  };
  const selection = defaultLaunch(settings, [gateway], config.agents)!;
  expect(launchChoice(selection)).toEqual({
    kind: "claude",
    profileId: "gateway",
    expectedProfileRevision: "3",
  });
  expect(
    launchChoice(
      defaultLaunch(
        { ...settings, model: { value: "  other-model  ", source: "global" } },
        [gateway],
        config.agents,
      )!,
    ),
  ).toEqual({
    kind: "claude",
    profileId: "gateway",
    expectedProfileRevision: "3",
    model: "other-model",
  });
  expect(launchProblem(selection, [{ ...gateway, revision: "4" }], config.agents)).toContain(
    "changed",
  );
  expect(launchProblem(selection, [], config.agents)).toContain("no longer");
  expect(launchChoice(selection).expectedProfileRevision).toBe("3");
});

test("without a usable default profile the configured agent wins, then the first enabled native agent", () => {
  const settings = {
    ...config.tasks,
    agent: { value: "pi" as const, source: "global" as const },
    profile: { value: "gone", source: "global" as const },
    model: { value: "pi-large", source: "global" as const },
  };
  expect(launchChoice(defaultLaunch(settings, [gateway], config.agents)!)).toEqual({
    kind: "pi",
    model: "pi-large",
  });
  expect(defaultLaunch(config.tasks, [], config.agents)?.kind).toBe("claude");
  const disabled = structuredClone(config.agents);
  for (const kind of AgentKind.options) disabled[kind].enabled = { value: false, source: "global" };
  expect(defaultLaunch(config.tasks, [gateway], disabled)).toBeUndefined();
  expect(launchProblem({ kind: "pi", profile: null, model: "" }, [], disabled)).toContain(
    "disabled",
  );
});

test("native agents precede profiles, and disabled tools cannot be selected through a profile", () => {
  expect(launchOptions([gateway], config.agents).map(launchKey)).toEqual([
    "native:claude",
    "native:codex",
    "native:pi",
    "native:opencode",
    "profile:gateway:3",
  ]);
  const agents = {
    ...config.agents,
    claude: { ...config.agents.claude, enabled: { value: false, source: "global" as const } },
  };
  expect(launchOptions([gateway], agents).some((option) => option.kind === "claude")).toBe(false);
});

test("the picker's selection maps to exactly one catalog row, including pi's provider-qualified id", () => {
  const native = { kind: "pi" as const, profile: null, model: "stub-1" };
  expect(launchCatalogRow(native, [stubOne, stubTwo])).toBe(stubOne);
  expect(launchCatalogRow({ ...native, model: "stub/stub-1" }, [stubOne, stubTwo])).toBe(stubOne);
  expect(
    launchCatalogRow({ kind: "pi", profile: { ...piStub, model: "stub/stub-1" }, model: "" }, [
      stubOne,
      stubTwo,
    ]),
  ).toBe(stubOne);
  expect(launchCatalogRow({ ...native, model: "" }, [stubOne, stubTwo])).toBeUndefined();
  expect(launchCatalogRow({ ...native, model: "missing" }, [stubOne, stubTwo])).toBeUndefined();
  expect(
    launchCatalogRow({ ...native, model: "stub-1" }, [stubOne, { ...stubOne, provider: "other" }]),
  ).toBeUndefined();
  // A provider pin must still choose the stub row when another provider reports the same id; without
  // the provider filter both rows match and the ambiguous two-candidate path would return undefined.
  expect(
    launchCatalogRow(
      { kind: "pi", profile: { ...piStub, provider: "stub", model: "stub-1" }, model: "" },
      [stubOne, { ...stubOne, provider: "other", name: "Other Stub One" }],
    ),
  ).toBe(stubOne);
});

test("the configured default is one row in the edited scope and is skipped when it cannot launch", () => {
  const settings = {
    ...config.tasks,
    agent: { value: "pi" as const, source: "global" as const },
    model: { value: "stub-1", source: "global" as const },
  };
  expect(
    configuredDefaultRow({ kind: "pi", profileId: null }, settings, [], config.agents, [
      stubOne,
      stubTwo,
    ]),
  ).toBe(stubOne);
  expect(
    configuredDefaultRow({ kind: "claude", profileId: null }, settings, [], config.agents, [
      stubOne,
      stubTwo,
    ]),
  ).toBeUndefined();
  expect(
    configuredDefaultRow(
      { kind: "pi", profileId: piStub.id },
      {
        ...settings,
        profile: { value: piStub.id, source: "global" as const },
        model: { value: null, source: "global" as const },
      },
      [piStub],
      config.agents,
      [stubOne, stubTwo],
    ),
  ).toBe(stubOne);
  expect(
    configuredDefaultRow(
      { kind: "pi", profileId: null },
      { ...settings, model: { value: "bad model", source: "global" as const } },
      [],
      config.agents,
      [stubOne, stubTwo],
    ),
  ).toBeUndefined();
  expect(CONFIGURED_DEFAULT).toBe("Configured default");
});

test("chat is the default, an explicit terminal setting wins and a missing driver falls back", () => {
  expect(launchView(config.tasks, "pi", ["pi"])).toBe("chat");
  expect(
    launchView({ ...config.tasks, view: { value: "terminal", source: "project" } }, "pi", ["pi"]),
  ).toBe("terminal");
  expect(launchView(config.tasks, "claude", ["pi"])).toBe("terminal");
});
