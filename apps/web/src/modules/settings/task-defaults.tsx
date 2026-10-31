import {
  namingConfigured,
  type NamingSettings,
  type ResolvedTaskSettings,
  type SettingSource,
} from "@corral/protocol/config";
import { Badge } from "../../common/ui/index.ts";
import { useConfig } from "../keymap/index.ts";

interface Row {
  label: string;
  value: string;
  source: SettingSource;
}

/** The values task creation and the composer use, each with the layer it resolved from. */
export function TaskDefaults() {
  const { config } = useConfig();
  return (
    <>
      <SettingRows rows={taskRows(config.tasks)} />
      <p className="mt-1 mb-0 text-muted-foreground">
        A launch profile wins over an agent, and a model overrides the profile's model.
      </p>
    </>
  );
}

/** `[naming]`, and the note that an empty section means seed titles only (decision 16). */
export function TaskNaming() {
  const { config } = useConfig();
  return (
    <>
      <SettingRows rows={namingRows(config.naming)} />
      {!namingConfigured(config.naming) && (
        <p className="mt-1 mb-0 text-muted-foreground">
          No naming profile or agent is set, so a task keeps the title derived from its prompt. Add{" "}
          <span className="font-mono text-xs">[naming]</span> with a profile, or an agent and model,
          to generate one.
        </p>
      )}
    </>
  );
}

/** Every `[projects."<path>"]` table, showing only the values it overrides. */
export function ProjectOverrides() {
  const { config } = useConfig();
  const projects = Object.entries(config.projects);
  if (projects.length === 0) {
    return (
      <p className="m-0 text-muted-foreground">
        No project overrides. Add a{" "}
        <span className="font-mono text-xs">[projects."&lt;absolute repository path&gt;"]</span>{" "}
        table to the config file; it takes the same keys as{" "}
        <span className="font-mono text-xs">[tasks]</span>.
      </p>
    );
  }
  return (
    <ul className="m-0 list-none p-0">
      {projects.map(([path, settings]) => (
        <ProjectOverrideRow key={path} path={path} settings={settings} />
      ))}
    </ul>
  );
}

function ProjectOverrideRow({ path, settings }: { path: string; settings: ResolvedTaskSettings }) {
  const rows = taskRows(settings).filter((row) => row.source === "project");
  return (
    <li className="py-1">
      <div className="break-all font-mono text-xs">{path}</div>
      {rows.length === 0 ? (
        <p className="m-0 mt-0.5 text-muted-foreground">No valid overrides.</p>
      ) : (
        <SettingRows rows={rows} nested />
      )}
    </li>
  );
}

function taskRows(settings: ResolvedTaskSettings): Row[] {
  return [
    { label: "Agent", value: settings.agent.value ?? "none", source: settings.agent.source },
    {
      label: "Launch profile",
      value: settings.profile.value ?? "none",
      source: settings.profile.source,
    },
    {
      label: "Model",
      value: settings.model.value ?? "agent default",
      source: settings.model.source,
    },
    { label: "Workspace", value: settings.workspace.value, source: settings.workspace.source },
    {
      label: "Worktree root",
      value: settings.worktreeRoot.value,
      source: settings.worktreeRoot.source,
    },
    {
      label: "Branch prefix",
      value: settings.branchPrefix.value === "" ? "none" : settings.branchPrefix.value,
      source: settings.branchPrefix.source,
    },
    { label: "Slug mode", value: settings.slugMode.value, source: settings.slugMode.source },
    { label: "View", value: settings.view.value, source: settings.view.source },
  ];
}

function namingRows(naming: NamingSettings): Row[] {
  return [
    {
      label: "Launch profile",
      value: naming.profile.value ?? "none",
      source: naming.profile.source,
    },
    { label: "Agent", value: naming.agent.value ?? "none", source: naming.agent.source },
    {
      label: "Model",
      value: naming.model.value ?? "agent default",
      source: naming.model.source,
    },
    {
      label: "Timeout",
      value: `${naming.timeoutSeconds.value} seconds`,
      source: naming.timeoutSeconds.source,
    },
  ];
}

function SettingRows({ rows, nested = false }: { rows: Row[]; nested?: boolean }) {
  return (
    <ul className={nested ? "m-0 mt-0.5 list-none p-0 pl-3" : "m-0 list-none p-0"}>
      {rows.map((row) => (
        <li key={row.label} className="flex flex-wrap items-center gap-2 py-0.5">
          <span className="flex-1 truncate">{row.label}</span>
          <span className="break-all font-mono text-xs">{row.value}</span>
          <Badge variant="outline">{row.source}</Badge>
        </li>
      ))}
    </ul>
  );
}
