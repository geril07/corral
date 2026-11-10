import { taskSettingsFor } from "@corral/protocol/config";
import { useSyncExternalStore } from "react";
import { Button, Icon } from "../../common/ui/index.ts";
import { useCorralClient } from "../connection/index.ts";
import { useConfig } from "../keymap/index.ts";
import {
  projectProblemPath,
  problemsUnder,
  SettingsCard,
  SettingsNote,
  SettingsProblems,
  SettingsRow,
} from "./settings-primitives.tsx";
import { taskSettingRows } from "./task-settings-rows.ts";

interface ProjectEntry {
  /** A stable key: the added project id, or the config-only path. */
  key: string;
  name: string;
  path: string;
  added: boolean;
}

function pathName(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

/**
 * Projects are file-owned, so this page reads config.toml and never edits it. With no project
 * chosen it lists the added projects plus any `[projects."<path>"]` table that has no added
 * project; with one chosen it shows that project's resolved task settings and its own problems.
 */
export function ProjectsSection({
  selectedPath,
  onSelect,
}: {
  selectedPath: string | undefined;
  onSelect: (path: string | undefined) => void;
}) {
  const client = useCorralClient();
  const { config, loaded, problems } = useConfig();
  const projectState = useSyncExternalStore(client.projects.subscribe, client.projects.getSnapshot);
  const added = projectState.projects;
  const addedPaths = new Set(added.map((project) => project.path));
  const entries: ProjectEntry[] = [
    ...added.map((project) => ({
      key: project.id,
      name: project.name,
      path: project.path,
      added: true,
    })),
    ...Object.keys(config.projects)
      .filter((path) => !addedPaths.has(path))
      .map((path) => ({ key: path, name: pathName(path), path, added: false })),
  ];
  if (!loaded) {
    return (
      <>
        <SettingsNote>waiting for the server's config…</SettingsNote>
        <ProjectPicker entries={projectState.loaded ? entries : []} onSelect={onSelect} />
      </>
    );
  }
  const selected =
    selectedPath === undefined
      ? undefined
      : (entries.find((entry) => entry.path === selectedPath) ?? {
          key: selectedPath,
          name: pathName(selectedPath),
          path: selectedPath,
          added: false,
        });
  if (selected === undefined) {
    return (
      <ProjectPicker
        entries={projectState.loaded ? entries : []}
        loading={!projectState.loaded}
        onSelect={onSelect}
      />
    );
  }
  const rows = taskSettingRows(taskSettingsFor(config, selected.path));
  const projectProblems = problemsUnder(problems, projectProblemPath(selected.path));
  return (
    <>
      <SettingsCard>
        <SettingsRow
          id="settings-projects-selected"
          title={selected.name}
          description={
            selected.added ? selected.path : `${selected.path} · no added project has this path`
          }
          control={
            <Button variant="outline" size="sm" onClick={() => onSelect(undefined)}>
              Change project
            </Button>
          }
        />
      </SettingsCard>
      <SettingsCard title="Task settings">
        {rows.map((row) => (
          <SettingsRow
            key={row.key}
            id={`settings-project-${row.key}`}
            title={row.label}
            value={row.value}
            source={row.source === "project" ? "project" : "inherited"}
          />
        ))}
      </SettingsCard>
      <SettingsProblems
        id="settings-projects-problems"
        problems={projectProblems}
        title="Project problems"
      />
      <SettingsNote>
        These values resolve from built-in defaults, then{" "}
        <span className="font-mono text-xs">[tasks]</span>, then{" "}
        <span className="font-mono text-xs">[projects.&quot;&lt;path&gt;&quot;]</span>. Edit
        config.toml to change them
      </SettingsNote>
    </>
  );
}

function ProjectPicker({
  entries,
  loading,
  onSelect,
}: {
  entries: readonly ProjectEntry[];
  loading?: boolean;
  onSelect: (path: string) => void;
}) {
  return (
    <SettingsCard id="settings-projects-picker" title="Choose a project">
      {loading ? (
        <SettingsRow title="Loading projects…" />
      ) : entries.length === 0 ? (
        <SettingsRow title="No projects yet" description="Add one from the workspace sidebar" />
      ) : (
        <ul className="settings-picker" aria-label="Projects">
          {entries.map((entry) => (
            <li key={entry.key} className="settings-picker-item">
              <Button
                variant="ghost"
                layout="navigation"
                aria-label={`Project settings for ${entry.name}`}
                onClick={() => onSelect(entry.path)}
              >
                <Icon name="project" />
                <span className="settings-picker-text">
                  <span className="settings-picker-name">
                    {entry.name}
                    {!entry.added && " · not an added project"}
                  </span>
                  <span className="settings-picker-path">{entry.path}</span>
                </span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}
