import { createFileRoute, useBlocker } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { SettingsScreen } from "../modules/settings/index.ts";
import { validateWorkspaceSearch } from "../modules/workspace/index.ts";

export const Route = createFileRoute("/_workspace/settings")({
  validateSearch: validateWorkspaceSearch,
  component: SettingsRoute,
});

function SettingsRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [busyNotice, setBusyNotice] = useState(false);
  // Discard closes by navigating normally; the route is unmounting, so this only has to cover
  // the one navigation the close funnel starts.
  const allowClose = useRef(false);
  const refuseBusy = useCallback(() => setBusyNotice(true), []);
  const shouldBlock = useCallback(() => {
    if (allowClose.current) return false;
    if (busy) refuseBusy();
    return true;
  }, [busy, refuseBusy]);
  const blocker = useBlocker({
    shouldBlockFn: shouldBlock,
    withResolver: true,
    disabled: !dirty && !busy,
  });
  // A close while busy is refused and immediately unwinds; nothing stays pending after settle.
  useEffect(() => {
    if (blocker.status === "blocked" && busy) blocker.reset();
  }, [blocker, busy]);
  const close = useCallback(() => {
    allowClose.current = true;
    void navigate({ to: "/", search, replace: true });
  }, [navigate, search]);
  const navigationGuard =
    blocker.status === "blocked" ? { cancel: blocker.reset, proceed: blocker.proceed } : undefined;
  return (
    <SettingsScreen
      onClose={close}
      onDirtyChange={setDirty}
      onBusyChange={(next) => {
        setBusy(next);
        if (!next) setBusyNotice(false);
      }}
      onBusyCloseRefused={refuseBusy}
      busyNotice={busyNotice}
      navigationGuard={navigationGuard}
    />
  );
}
