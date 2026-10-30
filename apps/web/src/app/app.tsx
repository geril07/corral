import type { CorralClient } from "@corral/client/corral-client";
import type { RouterHistory } from "@tanstack/react-router";
import { RouterProvider } from "@tanstack/react-router";
import { useState } from "react";
import { AppProviders } from "./providers.tsx";
import { createAppRouter } from "./router.tsx";

/** The whole client: providers plus the file-based router. Tests pass a memory history. */
export function App({ client, history }: { client: CorralClient; history?: RouterHistory }) {
  const [router] = useState(() => createAppRouter(history));
  return (
    <AppProviders client={client}>
      <RouterProvider router={router} />
    </AppProviders>
  );
}
