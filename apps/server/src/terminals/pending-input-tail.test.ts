import { expect, test } from "vite-plus/test";
import { PendingInputTail, pendingInputTail } from "./pending-input-tail.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const tailOf = (text: string) => new TextDecoder().decode(pendingInputTail(encode(text)));

test("a stream that ends cleanly has no tail", () => {
  expect(tailOf("plain \x1b[1;31mred\x1b[0m \x1b]0;title\x07 done")).toBe("");
});

test("an unfinished escape sequence is the tail, from its ESC", () => {
  expect(tailOf("text \x1b[1;3")).toBe("\x1b[1;3");
  expect(tailOf("text \x1b")).toBe("\x1b");
  expect(tailOf("text \x1b]0;a ti")).toBe("\x1b]0;a ti");
  expect(tailOf("text \x1bP1$q")).toBe("\x1bP1$q");
});

test("an ESC that may end a string leaves only that ESC", () => {
  expect(tailOf("\x1b]0;title\x1b")).toBe("\x1b");
});

test("a new ESC abandons the sequence it interrupts", () => {
  expect(tailOf("\x1b[12\x1b[3")).toBe("\x1b[3");
  expect(tailOf("\x1b]0;a\x1b[3")).toBe("\x1b[3");
});

test("a UTF-8 character cut short is the tail", () => {
  const bytes = encode("a✓");
  expect([...pendingInputTail(bytes.subarray(0, 2))]).toEqual([...bytes.subarray(1, 2)]);
  expect([...pendingInputTail(bytes.subarray(0, 3))]).toEqual([...bytes.subarray(1, 3)]);
  expect(pendingInputTail(bytes)).toHaveLength(0);
});

test("a runaway unterminated string is abandoned", () => {
  expect(tailOf(`\x1b]0;${"x".repeat(5000)}`)).toBe("");
});

test("feeding a stream in two chunks gives the tail of feeding it whole", () => {
  const stream = encode(
    "a✓\x1b[1;31mred✓\x1b[0m\x1b]0;t✓\x07 \x1bP1$q\x1b\\x\x1b]8;;http://x\x1b\\y\x1b[",
  );
  const whole = pendingInputTail(stream);
  for (let split = 0; split <= stream.length; split++) {
    const incremental = new PendingInputTail();
    incremental.push(stream.subarray(0, split));
    incremental.push(stream.subarray(split));
    expect([...incremental.bytes], `split at ${split}`).toEqual([...whole]);
  }
});
