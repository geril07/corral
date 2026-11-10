import type { ConfigProblem } from "@corral/protocol/config";
import { useId, type ReactNode } from "react";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./settings-sections.ts";

/**
 * Settings-only presentation: one section frame, one card, one row. These are the geometry the
 * settings slice owns; controls still come from `common/ui` and colours from the visual roles.
 */
export function SettingsSection({
  id,
  current,
  children,
}: {
  id: SettingsSectionId;
  current: SettingsSectionId;
  children: ReactNode;
}) {
  const section = SETTINGS_SECTIONS[id];
  const heading = `settings-panel-${id}-title`;
  return (
    <section
      id={`settings-panel-${id}`}
      hidden={id !== current}
      aria-labelledby={heading}
      className="settings-section"
    >
      <header className="settings-section-header">
        <h2 id={heading} tabIndex={-1} className="settings-section-title">
          {section.title}
        </h2>
        <p className="settings-section-description">{section.description}</p>
      </header>
      {children}
    </section>
  );
}

export function SettingsCard({
  id,
  title,
  note,
  children,
}: {
  id?: string | undefined;
  title?: string | undefined;
  note?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div
      id={id}
      tabIndex={id === undefined ? undefined : -1}
      className="settings-card"
      role="group"
      aria-label={title}
    >
      {title !== undefined && (
        <div className="settings-card-heading">
          <h3 className="settings-card-title">{title}</h3>
          {note !== undefined && <p className="settings-card-note">{note}</p>}
        </div>
      )}
      {children}
    </div>
  );
}

export function SettingsRow({
  id,
  title,
  description,
  value,
  source,
  reset,
  control,
  children,
}: {
  id?: string | undefined;
  title: string;
  description?: string | undefined;
  value?: string | undefined;
  /** `inherited` and `project` are the project page's two layers; other sections pass the raw one. */
  source?: string | undefined;
  /** A reset control beside the label, shown only when the value differs from its default. */
  reset?: ReactNode | undefined;
  control?: ReactNode | undefined;
  /** Extra content under the title, e.g. a problem sentence or an environment list. */
  children?: ReactNode | undefined;
}) {
  const descriptionId = useId();
  return (
    <div
      id={id}
      tabIndex={id === undefined ? undefined : -1}
      className="settings-row"
      aria-describedby={description === undefined ? undefined : descriptionId}
    >
      <div className="settings-row-text">
        <div className="settings-row-title-line">
          <span className="settings-row-title">{title}</span>
          {reset}
        </div>
        {description !== undefined && (
          <p id={descriptionId} className="settings-row-description">
            {description}
          </p>
        )}
        {children}
      </div>
      {(source !== undefined || value !== undefined || control !== undefined) && (
        <div className="settings-row-trailing">
          {value !== undefined && <span className="settings-row-value">{value}</span>}
          {source !== undefined && (
            <span
              className="settings-source"
              data-source={source === "project" ? "project" : undefined}
            >
              {source}
            </span>
          )}
          {control}
        </div>
      )}
    </div>
  );
}

export function SettingsNote({ children }: { children: ReactNode }) {
  return <p className="settings-note">{children}</p>;
}

/** Problems where the content lives; Diagnostics keeps the whole list too. */
export function SettingsProblems({
  id,
  problems,
  title = "Problems",
  empty,
}: {
  id?: string | undefined;
  problems: readonly ConfigProblem[];
  title?: string | undefined;
  empty?: { title: string; description: string } | undefined;
}) {
  if (problems.length === 0) {
    if (empty === undefined) return null;
    return (
      <SettingsCard id={id} title={title}>
        <SettingsRow title={empty.title} description={empty.description} />
      </SettingsCard>
    );
  }
  return (
    <SettingsCard id={id} title={title} note={`${problems.length}`}>
      <div className="settings-problems">
        {problems.map((problem) => (
          <div
            key={`${problem.severity}:${problem.path}:${problem.message}`}
            className="settings-problem"
          >
            <div className="settings-problem-head">
              <span className="settings-problem-severity" data-severity={problem.severity}>
                {problem.severity}
              </span>
              <span className="settings-problem-path">{problem.path || "(whole file)"}</span>
            </div>
            <p className="settings-problem-message">{problem.message}</p>
          </div>
        ))}
      </div>
    </SettingsCard>
  );
}

/** Problems whose dotted path is this table or one of its entries. */
export function problemsUnder(problems: readonly ConfigProblem[], path: string): ConfigProblem[] {
  return problems.filter((problem) => problem.path === path || problem.path.startsWith(`${path}.`));
}

/** The project page's own table path, quoted the way the config file writes it. */
export function projectProblemPath(path: string): string {
  return `projects."${path}"`;
}
