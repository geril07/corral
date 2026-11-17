// oxlint-disable-next-line import/no-unassigned-import -- the ring's transition and its reduce pair
import "./progress-ring.css";

/** How a ring that has crossed its comfortable range is drawn; the kit owns the colour choice. */
export type ProgressRingTone = "muted" | "danger";

/**
 * A 16 px ring for a 0–100 reading, drawn from twelve o'clock. `null` is a reading without a
 * limit: the track alone, so the control keeps its size and the caller can still name the count.
 */
export function ProgressRing({
  percentage,
  tone = "muted",
}: {
  percentage: number | null;
  tone?: ProgressRingTone | undefined;
}) {
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const filled = percentage === null ? 0 : Math.max(0, Math.min(100, percentage));
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      data-component="progress-ring"
      className="size-4 -rotate-90"
    >
      <circle
        cx="8"
        cy="8"
        r={radius}
        strokeWidth="2"
        data-slot="progress-ring-track"
        className="stroke-muted-foreground/25"
      />
      <circle
        cx="8"
        cy="8"
        r={radius}
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - filled / 100)}
        data-slot="progress-ring-progress"
        className={tone === "danger" ? "stroke-destructive" : "stroke-muted-foreground"}
      />
    </svg>
  );
}
