/**
 * An ordinary web link leaves the capability-bearing window: the desktop shell hands it to the OS
 * browser, a plain browser opens a tab (`docs/design.md`, **Local trust boundary**). One copy,
 * because chat's rendered links and the task's pull-request badge must obey the same rule.
 */
export function openWebLink(url: string): void {
  const bridge = window.corral;
  if (bridge !== undefined) {
    void bridge.openExternal(url).catch(() => undefined);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
