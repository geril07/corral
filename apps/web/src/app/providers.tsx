import type { CorralClient } from "@corral/client/corral-client";
import type { ReactNode } from "react";
import { CorralClientProvider } from "../modules/connection/index.ts";
import { KeymapProvider } from "../modules/keymap/index.ts";

export function AppProviders({
  client,
  prefix,
  children,
}: {
  client: CorralClient;
  prefix: string;
  children: ReactNode;
}) {
  return (
    <CorralClientProvider client={client}>
      <KeymapProvider prefix={prefix}>{children}</KeymapProvider>
    </CorralClientProvider>
  );
}
