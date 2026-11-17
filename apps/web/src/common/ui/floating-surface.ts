/**
 * The shell's one floating popup recipe: menus, submenus and select popups share this surface, as
 * OpenCode's `select-v2-content` is its `menu-v2-content`. The recipe itself is `.visual-surface` in
 * `visual-shell.css`; this string only carries the class and the enter placement.
 */
export const VISUAL_SURFACE_CLASS =
  "visual-surface origin-(--transform-origin) data-[side=bottom]:motion-safe:slide-in-from-top-2 data-[side=inline-end]:motion-safe:slide-in-from-left-2 data-[side=inline-start]:motion-safe:slide-in-from-right-2 data-[side=left]:motion-safe:slide-in-from-right-2 data-[side=right]:motion-safe:slide-in-from-left-2 data-[side=top]:motion-safe:slide-in-from-bottom-2 data-open:motion-safe:animate-in data-open:motion-safe:fade-in-0 data-open:motion-safe:zoom-in-95";
