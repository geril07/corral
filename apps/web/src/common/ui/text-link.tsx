import type { ComponentProps, ReactNode } from "react";
import { buttonVariants } from "./button.tsx";

/** Base UI Button would give an anchor role=button; links keep native link semantics. */
export function TextLink(props: Omit<ComponentProps<"a">, "className" | "style">) {
  return <a className={buttonVariants({ variant: "link" })} {...props} />;
}

/**
 * An inline anchor inside running text (chat Markdown, a file row). The kit renders the element so
 * modules never write `<a>` themselves, and it keeps the link styling Streamdown's own anchors use.
 * `href` stays real — middle-click and copy stay useful — while a plain click is the app's: the
 * browser's own navigation is prevented, and `onActivate` decides what happens instead, e.g. hand an
 * ordinary web link to the OS browser. A modified or non-primary click stays native.
 */
export function LinkAnchor({
  href,
  title,
  children,
  onActivate,
  ariaLabel,
}: {
  href: string;
  title?: string;
  children: ReactNode;
  /** The plain click, after the browser's navigation is prevented. */
  onActivate?: () => void;
  ariaLabel?: string;
}) {
  return (
    <a
      className="wrap-anywhere font-medium text-primary-text underline"
      data-streamdown="link"
      href={href}
      title={title}
      aria-label={ariaLabel}
      rel="noreferrer"
      target="_blank"
      onClick={
        onActivate === undefined
          ? undefined
          : (event) => {
              // A new tab, a middle click or a modifier click stays the browser's own navigation.
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              )
                return;
              event.preventDefault();
              onActivate();
            }
      }
    >
      {children}
    </a>
  );
}

/**
 * An inline, link-styled element for something that **does** work rather than goes somewhere — a
 * workspace file that opens the editor (`docs/ux.md`, **Local links in chat**). It is a button on
 * purpose: an `href` would let ctrl/cmd-click or a copied link promise a URL that does not exist,
 * and the app's hash route is not a place to point at. A click in any form runs the action.
 */
export function ActionLink({
  children,
  title,
  onActivate,
  ariaLabel,
}: {
  children: ReactNode;
  title?: string;
  onActivate: () => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      className="wrap-anywhere inline cursor-pointer border-0 bg-transparent p-0 text-left font-medium text-primary-text underline"
      title={title}
      aria-label={ariaLabel}
      onClick={onActivate}
    >
      {children}
    </button>
  );
}
