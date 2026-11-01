// A stand-in for a naming agent CLI: `bin/<name>` runs this with the agent's name.
//
// - appends one JSON line per run (arguments, working directory, the profile's sentinel variable)
//   to the file named by $FAKE_NAMING_LOG;
// - waits $FAKE_NAMING_DELAY_MS, writes $FAKE_NAMING_OUTPUT to stdout and exits with
//   $FAKE_NAMING_EXIT. A timeout test makes it wait longer than the configured timeout;
// - with $FAKE_NAMING_ESCAPE=1 it starts a detached grandchild that inherits stdout/stderr and
//   leaves the parent's process group, so only killing the group is not enough to close the pipes.
import { spawn } from "node:child_process";
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

if (process.env["FAKE_NAMING_ESCAPE"] === "1") {
  // Its own session (detached) keeps it out of the naming child's process group. It inherits the
  // stdout/stderr pipes and sleeps on, so killing the naming child does not close them.
  const escaped = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 10000);"], {
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
  escaped.unref();
}

const delay = Number(process.env["FAKE_NAMING_DELAY_MS"] ?? "0");
setTimeout(() => {
  process.stdout.write(process.env["FAKE_NAMING_OUTPUT"] ?? "");
  process.exit(Number(process.env["FAKE_NAMING_EXIT"] ?? "0"));
}, delay);
