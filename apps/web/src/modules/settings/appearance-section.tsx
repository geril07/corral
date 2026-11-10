import { Button, RadioChoice, RadioGroup } from "../../common/ui/index.ts";
import { useAppearance, UI_SCALES } from "./appearance.tsx";
import { SettingsCard, SettingsNote, SettingsRow } from "./settings-primitives.tsx";

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
            <RadioGroup
              aria-label="Session tab position"
              value={appearance.tabPosition}
              onValueChange={(value) => {
                if (value === "top" || value === "bottom") setTabPosition(value);
              }}
            >
              <RadioChoice value="top">Top</RadioChoice>
              <RadioChoice value="bottom">Bottom</RadioChoice>
            </RadioGroup>
          }
        />
        <SettingsRow
          id="settings-appearance-scale"
          title="Interface text scale"
          description="Relative to the system scale; terminal text stays at 14 px"
          control={
            <div
              className="flex flex-wrap justify-end gap-1"
              role="group"
              aria-label="Interface text scale"
            >
              {UI_SCALES.map((scale) => (
                <Button
                  key={scale}
                  size="sm"
                  variant={appearance.scale === scale ? "secondary" : "ghost"}
                  aria-pressed={appearance.scale === scale}
                  onClick={() => setScale(scale)}
                >
                  {scale}%
                </Button>
              ))}
            </div>
          }
        />
      </SettingsCard>
      <SettingsNote>Appearance is stored in this browser, not in config.toml</SettingsNote>
    </>
  );
}
