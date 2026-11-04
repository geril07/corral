import { createContext, useContext, useCallback, useMemo, useState, type ReactNode } from "react";

interface SettingsActivity {
  open: boolean;
  register: () => () => void;
}
const Context = createContext<SettingsActivity | undefined>(undefined);

/** Route settings and picker-owned settings cover the same mounted workspace. */
export function SettingsActivityProvider({ children }: { children: ReactNode }) {
  const [count, setCount] = useState(0);
  const register = useCallback(() => {
    setCount((value) => value + 1);
    return () => setCount((value) => value - 1);
  }, []);
  const activity = useMemo(() => ({ open: count > 0, register }), [count, register]);
  return <Context value={activity}>{children}</Context>;
}
export function useSettingsActivity() {
  return useContext(Context);
}
