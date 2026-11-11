import {
  Combobox,
  ComboboxButton,
  ComboboxContent,
  ComboboxItem,
  ComboboxList,
  IconButton,
  Slider,
} from "../../common/ui/index.ts";
import { DEFAULT_UI_SCALE, UI_SCALES, useAppearance } from "./appearance.tsx";
import { SettingsCard, SettingsNote, SettingsRow } from "./settings-primitives.tsx";

const TAB_POSITIONS = ["top", "bottom"] as const;
const TAB_LABELS = { top: "Top", bottom: "Bottom" } as const;

/** Device-only presentation settings; these never rewrite server-owned config.toml. */
export function AppearanceSection() {
  const { appearance, setScale, setTabPosition } = useAppearance();
  return (
    <>
      <SettingsCard>
        <SettingsRow
          id="settings-appearance-tabs"
          title="Session tab position"
          description="Where a task's session tabs sit above its content"
          control={
            <div className="settings-select">
              <Combobox
                items={TAB_POSITIONS}
                value={appearance.tabPosition}
                onValueChange={(value) => {
                  if (value === "top" || value === "bottom") setTabPosition(value);
                }}
              >
                <ComboboxButton layout="bounded" size="default" aria-label="Session tab position">
                  {TAB_LABELS[appearance.tabPosition]}
                </ComboboxButton>
                <ComboboxContent align="end" layout="anchor">
                  <ComboboxList>
                    {TAB_POSITIONS.map((position) => (
                      <ComboboxItem key={position} value={position}>
                        {TAB_LABELS[position]}
                      </ComboboxItem>
                    ))}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
            </div>
          }
        />
        <SettingsRow
          id="settings-appearance-scale"
          title="Interface text scale"
          description="Relative to the system scale; terminal text stays at 14 px"
          reset={
            appearance.scale === DEFAULT_UI_SCALE ? undefined : (
              <IconButton
                label="Reset interface text scale to default"
                tooltip="Reset to default"
                icon="reset"
                size="icon-micro"
                onClick={() => setScale(DEFAULT_UI_SCALE)}
              />
            )
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output className="settings-value-box" htmlFor="settings-text-scale">
                {appearance.scale}%
              </output>
              <Slider
                id="settings-text-scale"
                aria-label="Interface text scale"
                min={UI_SCALES[0]}
                max={UI_SCALES[UI_SCALES.length - 1]}
                step={10}
                value={appearance.scale}
                onChange={(event) => {
                  const next = UI_SCALES.find(
                    (scale) => scale === Number(event.currentTarget.value),
                  );
                  if (next !== undefined) setScale(next);
                }}
              />
            </div>
          }
        />
      </SettingsCard>
      <SettingsNote>Appearance is stored in this browser, not in config.toml</SettingsNote>
    </>
  );
}
