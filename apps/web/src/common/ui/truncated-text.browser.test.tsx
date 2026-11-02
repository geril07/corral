import { expect, test, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { useTruncatedText } from "./truncated-text.tsx";

/** A caller like the task header: the text arrives, the box may have no width yet. */
function Probe({ text, narrow }: { text: string; narrow?: boolean }) {
  const { observe, clipped, display } = useTruncatedText(text, "middle");
  return (
    <div className={narrow === true ? "w-0 overflow-hidden" : "w-64"}>
      {/* `block` so the span has a layout box: an inline span's `clientWidth` is always 0. */}
      <span ref={observe} data-testid="probe" className="block truncate">
        {display}
      </span>
      <span data-testid="clipped">{clipped ? "yes" : "no"}</span>
    </div>
  );
}

const read = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent;

test("a new text shows at once and is shortened only once the width is known", async () => {
  const screen = await render(<Probe text="shorter" />);
  await vi.waitFor(() => expect(read("probe")).toBe("shorter"));
  expect(read("clipped")).toBe("no");

  // Wider than the 256 px box: the measured form is an ellipsis, and the flag says it was clipped.
  const long = "x".repeat(120);
  await screen.rerender(<Probe text={long} />);
  await vi.waitFor(() => {
    expect(read("probe")?.length).toBeLessThan(long.length);
    expect(read("clipped")).toBe("yes");
  });

  // A text change while the box has no width still shows the new text (the header's case).
  await screen.rerender(<Probe text="narrow again" narrow />);
  await vi.waitFor(() => expect(read("probe")).toBe("narrow again"));
  expect(read("clipped")).toBe("no");
});
