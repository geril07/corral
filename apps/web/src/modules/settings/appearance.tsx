import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export const UI_SCALES = [80, 90, 100, 110, 120, 130, 140] as const;
export const DEFAULT_UI_SCALE = 100;
type Scale = (typeof UI_SCALES)[number];
type TabPosition = "top" | "bottom";
interface Appearance {
  scale: Scale;
  tabPosition: TabPosition;
}
const DEFAULTS: Appearance = { scale: DEFAULT_UI_SCALE, tabPosition: "top" };
const STORAGE_KEY = "corral.appearance";

function read(): Appearance {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof saved !== "object" || saved === null) return DEFAULTS;
    return {
      scale:
        ("scale" in saved ? UI_SCALES.find((scale) => scale === saved.scale) : undefined) ??
        DEFAULTS.scale,
      tabPosition: "tabPosition" in saved && saved.tabPosition === "bottom" ? "bottom" : "top",
    };
  } catch {
    return DEFAULTS;
  }
}

const AppearanceContext = createContext<
  | {
      appearance: Appearance;
      setScale: (scale: Scale) => void;
      setTabPosition: (position: TabPosition) => void;
    }
  | undefined
>(undefined);

/** Device-only presentation settings; these never rewrite server-owned config.toml. */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState(read);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
    } catch {
      /* A denied preference write must not prevent using the interface. */
    }
  }, [appearance]);
  useEffect(() => {
    const element = document.documentElement,
      previous = element.style.fontSize;
    element.style.fontSize = `${appearance.scale}%`;
    return () => {
      element.style.fontSize = previous;
    };
  }, [appearance.scale]);
  const value = useMemo(
    () => ({
      appearance,
      setScale: (scale: Scale) => setAppearance((current) => ({ ...current, scale })),
      setTabPosition: (tabPosition: TabPosition) =>
        setAppearance((current) => ({ ...current, tabPosition })),
    }),
    [appearance],
  );
  return <AppearanceContext value={value}>{children}</AppearanceContext>;
}

export function useAppearance() {
  const context = useContext(AppearanceContext);
  if (!context) throw new Error("AppearanceProvider is missing");
  return context;
}
