import { contract } from "@corral/protocol/rpc";
import { implement } from "@orpc/server";
import type { TerminalRegistry } from "../terminals/terminal-registry.ts";

export function createRpcRouter(terminals: TerminalRegistry) {
  const os = implement(contract);
  return os.router({
    terminals: {
      list: os.terminals.list.handler(() => terminals.list()),
      create: os.terminals.create.handler(({ input }) => terminals.create(input)),
      close: os.terminals.close.handler(({ input, errors }) => {
        if (!terminals.close(input.id)) throw errors.NOT_FOUND({ data: { id: input.id } });
      }),
      watch: os.terminals.watch.handler(({ signal }) => terminals.watch(signal)),
    },
  });
}
