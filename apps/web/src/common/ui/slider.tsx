import * as React from "react";
import { cn } from "../lib/cn.ts";

type SliderStyle = React.CSSProperties & { "--visual-slider-progress": string };

/**
 * A range control with the settings slider recipe. The track fill follows `value`; the caller
 * supplies labels and formatting, never a className.
 */
function Slider({ className, value, min = 0, max = 100, ...props }: React.ComponentProps<"input">) {
  const numericValue = typeof value === "number" ? value : Number(value ?? min);
  const numericMin = Number(min);
  const numericMax = Number(max);
  const progress =
    numericMax === numericMin ? 0 : ((numericValue - numericMin) / (numericMax - numericMin)) * 100;
  const style: SliderStyle = { "--visual-slider-progress": `${progress}%` };
  return (
    <input
      type="range"
      data-slot="slider"
      className={cn("visual-slider", className)}
      value={value}
      min={min}
      max={max}
      style={style}
      {...props}
    />
  );
}

export { Slider };
