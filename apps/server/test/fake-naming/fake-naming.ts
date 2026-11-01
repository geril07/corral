// A stand-in for a naming agent CLI: `bin/<name>` runs this with the agent's name.
//
// - appends one JSON line per run (arguments, working directory, the profile's sentinel variable)
//   to the file named by $FAKE_NAMING_LOG;
// - waits $FAKE_NAMING_DELAY_MS, writes $FAKE_NAMING_OUTPUT to stdout and exits with
//   $FAKE_NAMING_EXIT. A timeout test makes it wait longer than the configured timeout.
import { appendFileSync } from "node:fs";

const [name, ...argv] = process.argv.slice(2);
const logFile = process.env["FAKE_NAMING_LOG"];
if (logFile !== undefined) {
  appendFileSync(
    logFile,
    `${JSON.stringify({
      agent: name,
      argv,
      cwd: process.cwd(),
      env: { ANTHROPIC_AUTH_TOKEN: process.env["ANTHROPIC_AUTH_TOKEN"] },
    })}\n`,
  );
}

const delay = Number(process.env["FAKE_NAMING_DELAY_MS"] ?? "0");
setTimeout(() => {
  process.stdout.write(process.env["FAKE_NAMING_OUTPUT"] ?? "");
  process.exit(Number(process.env["FAKE_NAMING_EXIT"] ?? "0"));
}, delay);
