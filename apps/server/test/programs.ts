/** Small programs to run in a PTY. Each waits on stdin where the test needs to steer it. */

export interface Program {
  command: string;
  args: string[];
}

export function sh(script: string): Program {
  return { command: "/bin/sh", args: ["-c", script] };
}

// Prints `n=00000000`, `n=00000001`, … as fast as the PTY takes them, until any input line
// arrives; then prints `final n=<count>` and exits. Echo is off so input does not mix in.
const COUNTER_SCRIPT = `
let n = 0;
let stop = false;
process.stdin.on("data", () => { stop = true; });
function tick() {
  if (stop) { process.stdout.write("final n=" + n + "\\n"); process.exit(0); }
  let chunk = "";
  for (let i = 0; i < 200; i++) chunk += "n=" + String(n++).padStart(8, "0") + "\\n";
  process.stdout.write(chunk);
  setImmediate(tick);
}
tick();
`;

export const counter: Program = {
  command: "/bin/sh",
  args: ["-c", 'stty -echo; exec "$0" -e "$1"', process.execPath, COUNTER_SCRIPT],
};

/** Lines `n=…` of the counter in a screen, as numbers. */
export function counterValues(lines: string[]): number[] {
  return lines.filter((line) => /^n=\d{8}$/.test(line)).map((line) => Number(line.slice(2)));
}

export function isContiguous(values: number[]): boolean {
  return values.every((value, index) => index === 0 || value === values[index - 1]! + 1);
}
