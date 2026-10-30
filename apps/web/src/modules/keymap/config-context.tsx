import type { ConfigSnapshot } from "@corral/client/config-store";
import { createContext, useContext, type ReactNode } from "react";

const ConfigContext = createContext<ConfigSnapshot | undefined>(undefined);

export function KeymapProvider({
  config,
  children,
}: {
  config: ConfigSnapshot;
  children: ReactNode;
}) {
  return <ConfigContext value={config}>{children}</ConfigContext>;
}

export function useConfig(): ConfigSnapshot {
  const config = useContext(ConfigContext);
  if (!config) throw new Error("no config in this tree");
  return config;
}

export function usePrefix(): string {
  return useConfig().config.keys.prefix;
}
