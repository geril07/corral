import type { CorralClient } from "@corral/client/corral-client";
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { DialogFocusProvider } from "../common/ui/index.ts";
import { CorralClientProvider } from "../modules/connection/index.ts";
import { KeymapProvider } from "../modules/keymap/index.ts";
import { AppearanceProvider, SettingsActivityProvider } from "../modules/settings/index.ts";

export function AppProviders({ client, children }: { client: CorralClient; children: ReactNode }) {
  const config = useSyncExternalStore(client.config.subscribe, client.config.getSnapshot);
  return (
    <CorralClientProvider client={client}>
      <DialogFocusProvider>
        <AppearanceProvider>
          <SettingsActivityProvider>
            <KeymapProvider config={config}>{children}</KeymapProvider>
          </SettingsActivityProvider>
        </AppearanceProvider>
      </DialogFocusProvider>
    </CorralClientProvider>
  );
}
