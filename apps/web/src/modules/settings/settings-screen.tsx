import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Button,
  DestructiveTaskDialog,
  DialogActions,
  Icon,
  IconButton,
  Input,
  Kbd,
  TaskDialog,
} from "../../common/ui/index.ts";
import { useCorralClient } from "../connection/index.ts";
import { useConfig } from "../keymap/index.ts";
import { AppearanceSection } from "./appearance-section.tsx";
import { AgentsSection } from "./agents.tsx";
import { DiagnosticsSection } from "./diagnostics-section.tsx";
import { KeyboardSection } from "./keyboard-section.tsx";
import { ModelManagement, type ModelManagementTarget } from "./model-management.tsx";
import { ProfileList } from "./profile-list.tsx";
import { ProjectsSection } from "./projects-section.tsx";
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingsSectionId } from "./settings-sections.ts";
import { searchSettings, settingsSearchItems, type SettingsSearchItem } from "./settings-search.ts";
import { SettingsCard, SettingsSection, SettingsRow } from "./settings-primitives.tsx";
import { useSettingsActivity } from "./settings-activity.tsx";
import { NamingSection, TaskDefaultsSection } from "./task-sections.tsx";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const panelId = (id: SettingsSectionId) => `settings-panel-${id}`;

function firstPanelControl(id: SettingsSectionId) {
  return document.getElementById(panelId(id))?.querySelector<HTMLElement>(FOCUSABLE) ?? null;
}

/** The visible panel's first control, else its heading; never a control from a hidden panel. */
function firstPanelFocus(id: SettingsSectionId) {
  const panel = document.getElementById(panelId(id));
  if (!panel || panel.hidden) return null;
  return (
    panel.querySelector<HTMLElement>(FOCUSABLE) ?? document.getElementById(`${panelId(id)}-title`)
  );
}

export interface SettingsNavigationGuard {
  cancel: () => void;
  proceed: () => void;
}

export function SettingsScreen({
  onClose,
  modelTarget,
  projectTarget,
  onDirtyChange,
  onBusyChange,
  onBusyCloseRefused,
  busyNotice,
  navigationGuard,
}: {
  onClose: () => void;
  modelTarget?: ModelManagementTarget | undefined;
  /** A project path: opens Projects with that project selected. */
  projectTarget?: string | undefined;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
  /** The routed screen records a refused close so it survives the immediate navigation reset. */
  onBusyCloseRefused?: (() => void) | undefined;
  busyNotice?: boolean | undefined;
  /** The routed screen passes the pending history navigation; picker-owned Settings does not. */
  navigationGuard?: SettingsNavigationGuard | undefined;
}) {
  const client = useCorralClient();
  const { config, profiles, problems } = useConfig();
  const registerSettings = useSettingsActivity()?.register;
  useLayoutEffect(() => registerSettings?.(), [registerSettings]);
  const projectState = useSyncExternalStore(client.projects.subscribe, client.projects.getSnapshot);
  const [current, setCurrent] = useState<SettingsSectionId>(() =>
    projectTarget !== undefined ? "projects" : modelTarget ? "models" : "appearance",
  );
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | undefined>(
    () => projectTarget,
  );
  const [modelsDirty, setModelsDirty] = useState(false);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [localBusyNotice, setLocalBusyNotice] = useState(false);
  const [closing, setClosing] = useState(false);
  const [query, setQuery] = useState("");
  const [activeResult, setActiveResult] = useState(0);
  const [reveal, setReveal] = useState<{ id: string; nonce: number }>();
  const lastFocused = useRef<HTMLElement | null>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<SettingsSectionId, number>());
  const highlighted = useRef<HTMLElement | null>(null);
  const highlightTimer = useRef<number | undefined>(undefined);
  const revealNonce = useRef(0);

  const searchItems = useMemo(
    () =>
      settingsSearchItems({
        config,
        profiles,
        projects: projectState.projects,
        selectedProjectPath,
      }),
    [config, profiles, projectState.projects, selectedProjectPath],
  );
  const results = useMemo(() => searchSettings(query, searchItems), [query, searchItems]);
  const activeIndex = Math.min(activeResult, Math.max(0, results.length - 1));
  const active = results[activeIndex];

  const visit = (id: SettingsSectionId) => {
    if (id === current) return;
    positions.current.set(current, content.current?.scrollTop ?? 0);
    setCurrent(id);
  };
  useLayoutEffect(() => {
    if (content.current) content.current.scrollTop = positions.current.get(current) ?? 0;
  }, [current, content, positions]);
  // The reveal runs after React has switched the hidden panel and inserted a selected project.
  useLayoutEffect(() => {
    if (reveal === undefined) return;
    const target = document.getElementById(reveal.id);
    if (target === null) return;
    target.scrollIntoView({ block: "nearest" });
    target.focus({ preventScroll: true });
    if (content.current) positions.current.set(current, content.current.scrollTop);
    highlighted.current?.removeAttribute("data-highlight");
    highlighted.current = target;
    target.setAttribute("data-highlight", "true");
    window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => {
      target.removeAttribute("data-highlight");
      if (highlighted.current === target) highlighted.current = null;
    }, 1300);
  }, [reveal, current, content, positions]);
  useLayoutEffect(
    () => () => {
      window.clearTimeout(highlightTimer.current);
      highlighted.current?.removeAttribute("data-highlight");
    },
    [],
  );

  // `/` focuses the search field unless the keyboard is in a text field or a nested popup.
  useLayoutEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
          return;
        const dialog = searchField.current?.closest('[data-slot="dialog-content"]');
        if (target !== document.body && dialog && !dialog.contains(target)) return;
      }
      event.preventDefault();
      searchField.current?.focus();
      searchField.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useLayoutEffect(() => {
    const remember = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      // The confirm is the thing being dismissed; its controls are never the return target.
      if (target.closest('[data-slot="alert-dialog-content"]')) return;
      lastFocused.current = target;
    };
    document.addEventListener("focusin", remember, true);
    return () => document.removeEventListener("focusin", remember, true);
  }, []);

  const changeQuery = (next: string) => {
    setQuery(next);
    setActiveResult(0);
  };
  const selectResult = (item: SettingsSearchItem) => {
    if (item.projectPath !== undefined) setSelectedProjectPath(item.projectPath);
    positions.current.set(current, content.current?.scrollTop ?? 0);
    if (item.section !== current) setCurrent(item.section);
    changeQuery("");
    revealNonce.current += 1;
    setReveal({ id: item.targetId ?? item.id, nonce: revealNonce.current });
  };
  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && query !== "") {
      event.preventDefault();
      event.stopPropagation();
      changeQuery("");
      return;
    }
    if (query === "" || results.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveResult((index) => (Math.min(index, results.length - 1) + 1) % results.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveResult(
        (index) => (Math.min(index, results.length - 1) - 1 + results.length) % results.length,
      );
    } else if (event.key === "Enter" && active !== undefined) {
      event.preventDefault();
      selectResult(active);
    }
  };

  const confirmOpen = (closing || navigationGuard !== undefined) && modelsDirty && !modelsBusy;
  const refusedBusy = busyNotice ?? localBusyNotice;
  /** The dialog's X and Escape ask here; a draft or an in-flight save keeps the dialog open. */
  const requestClose = () => {
    if (modelsBusy) {
      setLocalBusyNotice(true);
      onBusyCloseRefused?.();
      return false;
    }
    if (modelsDirty) {
      setClosing(true);
      return false;
    }
    return true;
  };
  const keepEditing = () => {
    setClosing(false);
    navigationGuard?.cancel();
  };
  const discard = () => {
    setClosing(false);
    if (navigationGuard) navigationGuard.proceed();
    else onClose();
  };
  const finalFocus = () => {
    const target = lastFocused.current;
    if (
      target?.isConnected &&
      target.closest('[data-slot="dialog-content"]') &&
      !target.closest("[hidden]")
    )
      return target;
    return firstPanelControl(current);
  };

  const initialFocus =
    projectTarget !== undefined
      ? () => document.getElementById("settings-projects-selected")
      : modelTarget
        ? () => firstPanelFocus("models")
        : () => document.getElementById(`settings-nav-${current}`);

  return (
    <TaskDialog
      title="Settings"
      layout="settings"
      onClose={onClose}
      beforeClose={requestClose}
      initialFocus={initialFocus}
      closeLabel="Close settings"
    >
      {modelsBusy && refusedBusy && (
        <div role="status" className="shrink-0 border-b border-border px-5 py-2 text-xs">
          The save must finish before Settings can close.
        </div>
      )}
      <div className="settings-body">
        <nav aria-label="Settings categories" className="settings-nav">
          <div className="settings-search">
            <Icon name="find" />
            <Input
              ref={searchField}
              type="text"
              aria-label="Search settings"
              placeholder="Search"
              value={query}
              role="combobox"
              aria-expanded={query !== ""}
              aria-controls="settings-results"
              aria-activedescendant={
                active === undefined ? undefined : `settings-result-${active.id}`
              }
              onChange={(event) => changeQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
            />
            {query === "" ? (
              <span className="settings-search-keycap" aria-hidden="true">
                <Kbd>/</Kbd>
              </span>
            ) : (
              <IconButton
                label="Clear settings search"
                icon="close"
                size="icon-xs"
                onClick={() => changeQuery("")}
              />
            )}
          </div>
          <div className="settings-nav-scroll">
            {query !== "" ? (
              results.length === 0 ? (
                <div className="settings-results-empty" role="status">
                  No settings found
                </div>
              ) : (
                <ul
                  id="settings-results"
                  role="listbox"
                  aria-label="Settings results"
                  className="settings-results"
                >
                  {results.map((item, index) => (
                    <li
                      key={item.id}
                      id={`settings-result-${item.id}`}
                      role="option"
                      aria-selected={index === activeIndex}
                      className="settings-result"
                    >
                      <Button
                        variant="ghost"
                        tabIndex={-1}
                        onMouseMove={() => setActiveResult(index)}
                        onClick={() => selectResult(item)}
                      >
                        <span className="settings-result-text">
                          <span className="settings-result-title">{item.title}</span>
                          <span className="settings-result-section">
                            {SETTINGS_SECTIONS[item.section].title}
                          </span>
                        </span>
                      </Button>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              <div className="settings-nav-groups">
                {SETTINGS_GROUPS.map((group) => (
                  <div
                    key={group.heading}
                    role="group"
                    aria-label={group.heading}
                    className="settings-nav-group"
                  >
                    <h3 className="settings-nav-heading">{group.heading}</h3>
                    {group.sections.map((id) => {
                      const section = SETTINGS_SECTIONS[id];
                      return (
                        <div key={id} className="settings-nav-item">
                          <Button
                            id={`settings-nav-${id}`}
                            data-settings-nav-item
                            variant="ghost"
                            layout="navigation"
                            aria-current={current === id ? "page" : undefined}
                            aria-controls={panelId(id)}
                            onClick={() => visit(id)}
                          >
                            <Icon name={section.icon} />
                            <span className="settings-nav-label">{section.title}</span>
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        </nav>
        <div ref={content} className="settings-content visual-scrollbar">
          <div className="settings-page">
            <SettingsSection id="appearance" current={current}>
              <AppearanceSection />
            </SettingsSection>
            <SettingsSection id="keyboard" current={current}>
              <KeyboardSection />
            </SettingsSection>
            <SettingsSection id="defaults" current={current}>
              <TaskDefaultsSection />
            </SettingsSection>
            <SettingsSection id="naming" current={current}>
              <NamingSection />
            </SettingsSection>
            <SettingsSection id="profiles" current={current}>
              <ProfileList profiles={profiles} problems={problems} />
            </SettingsSection>
            <SettingsSection id="agents" current={current}>
              <AgentsSection />
            </SettingsSection>
            <SettingsSection id="models" current={current}>
              <ModelsSection
                active={current === "models"}
                target={modelTarget}
                onDirty={(dirty) => {
                  setModelsDirty(dirty);
                  onDirtyChange?.(dirty);
                }}
                onBusy={(busy) => {
                  setModelsBusy(busy);
                  if (!busy) setLocalBusyNotice(false);
                  onBusyChange?.(busy);
                }}
              />
            </SettingsSection>
            <SettingsSection id="projects" current={current}>
              <ProjectsSection
                selectedPath={selectedProjectPath}
                onSelect={setSelectedProjectPath}
              />
            </SettingsSection>
            <SettingsSection id="diagnostics" current={current}>
              <DiagnosticsSection />
            </SettingsSection>
          </div>
        </div>
      </div>
      {confirmOpen && (
        <DestructiveTaskDialog
          title="Discard unsaved model preferences?"
          description="Model preferences, including visibility and favorites, have not been saved."
          onClose={keepEditing}
          finalFocus={finalFocus}
        >
          <DialogActions>
            <Button variant="outline" autoFocus onClick={keepEditing}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={discard}>
              Discard and close
            </Button>
          </DialogActions>
        </DestructiveTaskDialog>
      )}
    </TaskDialog>
  );
}

function ModelsSection({
  active,
  target,
  onDirty,
  onBusy,
}: {
  active: boolean;
  target?: ModelManagementTarget | undefined;
  onDirty: (dirty: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  return (
    <>
      <SettingsCard>
        <SettingsRow
          id="settings-models-preferences"
          title="Shared preferences"
          description="Visibility, favorites and order for one agent or profile; the server keeps them"
        />
      </SettingsCard>
      <div className="settings-model-panel">
        <ModelManagement active={active} target={target} onDirty={onDirty} onBusy={onBusy} />
      </div>
    </>
  );
}
