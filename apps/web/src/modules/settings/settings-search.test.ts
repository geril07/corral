import { defaultClientConfig } from "@corral/protocol/config";
import { describe, expect, it } from "vite-plus/test";
import { searchSettings, settingsSearchItems, type SettingsSearchItem } from "./settings-search.ts";

const item = (
  id: string,
  title: string,
  aliases: readonly string[] = [],
  secondary = false,
): SettingsSearchItem => ({ id, title, section: "keyboard", aliases, secondary });

const ids = (query: string, items: readonly SettingsSearchItem[]) =>
  searchSettings(query, items).map((result) => result.id);

describe("settings search", () => {
  it("ranks exact title, prefix, substring, all title tokens, then a phrase in another field", () => {
    const items = [
      item("phrase", "Misc", ["worktree root"]),
      item("tokens", "Worktree path root"),
      item("substring", "Project worktree root"),
      item("prefix", "Worktree root path"),
      item("exact", "worktree root"),
    ];
    expect(ids("worktree root", items)).toEqual([
      "exact",
      "prefix",
      "substring",
      "tokens",
      "phrase",
    ]);
  });

  it("puts generated secondary rows after real settings at any rank", () => {
    const items = [item("generated", "Model", [], true), item("authored", "Model settings")];
    expect(ids("model", items)).toEqual(["authored", "generated"]);
  });

  it("matches the section label and authored aliases, never the description prose", () => {
    const items = [item("scale", "Interface text scale", ["zoom"])];
    expect(ids("interface", items)).toEqual(["scale"]);
    expect(ids("zoom", items)).toEqual(["scale"]);
    expect(ids("saved on this device", items)).toEqual([]);
  });

  it("returns nothing for an empty query", () => {
    expect(searchSettings("   ", [item("scale", "Scale")])).toEqual([]);
  });
});

describe("settings index", () => {
  const config = defaultClientConfig("/data");

  it("marks generated actions, profiles, agents and projects as secondary", () => {
    const items = settingsSearchItems({
      config,
      profiles: [
        {
          id: "work",
          name: "Work",
          agent: "pi",
          model: null,
          provider: null,
          env: [],
          literalEnvNames: [],
          command: null,
          args: [],
          enabled: true,
          revision: "1",
        },
      ],
      projects: [{ id: "p1", name: "repo", path: "/repos/repo", defaultBaseBranch: "main" }],
      selectedProjectPath: "/repos/repo",
    });
    const byTitle = (title: string) => items.filter((entry) => entry.title === title);
    expect(byTitle("Work")[0]?.secondary).toBe(true);
    expect(byTitle("New terminal")[0]?.secondary).toBe(true);
    expect(byTitle("pi")[0]?.secondary).toBe(true);
    expect(byTitle("repo")[0]).toMatchObject({ secondary: true, projectPath: "/repos/repo" });
    expect(byTitle("Interface text scale")[0]?.secondary).toBeUndefined();
  });

  it("adds a selected project's task rows and the authored project picker", () => {
    const items = settingsSearchItems({
      config,
      profiles: [],
      projects: [],
      selectedProjectPath: "/repos/app",
    });
    expect(items.some((entry) => entry.id === "settings-project-branch-prefix")).toBe(true);
    expect(items.some((entry) => entry.id === "settings-projects-picker")).toBe(true);
  });
});
