import type { Terminal } from "@xterm/headless";
import { OSC_ID, QUERY_REPLY, parseBody } from "./osc7501-protocol.ts";
import type { Osc7501Records } from "./osc7501-records.ts";

export interface Osc7501Hooks {
  records: Osc7501Records;
  /** Bytes for the program's stdin; called once per `?` probe. */
  reply(data: string): void;
  /** The records took a report or ended its program; their status may have changed. */
  changed(): void;
  now(): number;
}

/**
 * Feeds the terminal's parsed stream into the records and answers the probe. Registered on the
 * server's headless terminal only, which sees every byte once and never replays one, so each
 * probe is answered exactly once and a restored snapshot answers none. Clients do not answer.
 * Because the reply is written while the probe is parsed, it reaches the program before the
 * reply to a DA1 sentinel that follows the probe, which a client sends after it has the bytes.
 */
export function installOsc7501Handlers(terminal: Terminal, hooks: Osc7501Hooks): void {
  const { parser } = terminal;
  parser.registerOscHandler(OSC_ID, (data) => {
    const message = parseBody(data);
    if (message?.type === "query") {
      hooks.reply(QUERY_REPLY);
    } else if (message?.type === "report") {
      hooks.records.apply(message.report, hooks.now());
      hooks.changed();
    }
    return true;
  });
  // A new shell prompt (OSC 133;A) and a full reset (RIS) end the program the records belong to.
  // They only observe: the terminal itself still handles both.
  parser.registerOscHandler(133, (data) => {
    if (data === "A" || data.startsWith("A;")) {
      hooks.records.endProgram();
      hooks.changed();
    }
    return false;
  });
  parser.registerEscHandler({ final: "c" }, () => {
    hooks.records.reset();
    hooks.changed();
    return false;
  });
}
