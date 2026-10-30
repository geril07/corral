import { createContext, useContext, type ReactNode } from "react";

const PrefixContext = createContext("alt+a");

export function KeymapProvider({ prefix, children }: { prefix: string; children: ReactNode }) {
  return <PrefixContext value={prefix}>{children}</PrefixContext>;
}

export function usePrefix(): string {
  return useContext(PrefixContext);
}
