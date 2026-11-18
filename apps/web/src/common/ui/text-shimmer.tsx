// oxlint-disable-next-line import/no-unassigned-import -- the shimmer's keyframes and reduce pair
import "./text-shimmer.css";

/**
 * OpenCode's `TextShimmer` (`packages/ui/src/typography/text-shimmer`): the label is drawn twice,
 * a quiet base and a bright copy seen through a soft window that travels across it. The moving
 * highlight, not a brighter colour, says that work is happening, so a live row stays quieter than
 * the answer it will produce. The base layer carries the accessible text; the copy is hidden.
 *
 * The sweep runs only while `active`; a label that stops working fades the copy out and leaves the
 * base, so no animation keeps looping behind a finished or waiting row.
 */
export function TextShimmer({
  text,
  active = true,
}: {
  text: string;
  /** False when the work stopped or is waiting on the user: the copy fades, the base remains. */
  active?: boolean;
}) {
  return (
    <span data-component="text-shimmer" data-active={active ? "true" : "false"}>
      <span data-slot="text-shimmer-base">{text}</span>
      <span data-slot="text-shimmer-shimmer" aria-hidden="true">
        {text}
        <span data-slot="text-shimmer-sweep">
          <span data-slot="text-shimmer-sweep-text">{text}</span>
        </span>
      </span>
    </span>
  );
}
