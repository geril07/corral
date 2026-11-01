import { createMemoryHistory } from "@tanstack/react-router";
import type { CorralClient } from "@corral/client/corral-client";
import { useState } from "react";
import { render } from "vitest-browser-react";
import { App as RootApp } from "../src/app/app.tsx";

const DEFAULT_INITIAL_ENTRIES: string[] = ["/"];

/** The real app on a memory history, with the client the test built. */
export function App({
  client,
  initialEntries = DEFAULT_INITIAL_ENTRIES,
}: {
  client: CorralClient;
  initialEntries?: string[];
}) {
  // Copy the entries: a memory history mutates the array it is given, and the default is shared.
  const [history] = useState(() => createMemoryHistory({ initialEntries: [...initialEntries] }));
  return <RootApp client={client} history={history} />;
}

/** Like `App`, but returns the history so a test can read the URL and render a fresh app from it. */
export async function renderApp(client: CorralClient, initialEntries: string[] = ["/"]) {
  const history = createMemoryHistory({ initialEntries: [...initialEntries] });
  const screen = await render(<RootApp client={client} history={history} />);
  return { ...screen, history };
}
