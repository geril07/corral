import { z } from "zod";

/** Bumped on any wire change a peer of the other version would misread. */
export const PROTOCOL_VERSION = 1;

export const ClientHello = z.object({
  type: z.literal("hello"),
  protocolVersion: z.number().int().positive(),
});
export type ClientHello = z.infer<typeof ClientHello>;

export const ServerHello = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), protocolVersion: z.number().int().positive() }),
  z.object({
    type: z.literal("rejected"),
    reason: z.literal("protocol-mismatch"),
    serverProtocolVersion: z.number().int().positive(),
  }),
]);
export type ServerHello = z.infer<typeof ServerHello>;

export function answerHello(hello: ClientHello): ServerHello {
  return hello.protocolVersion === PROTOCOL_VERSION
    ? { type: "welcome", protocolVersion: PROTOCOL_VERSION }
    : { type: "rejected", reason: "protocol-mismatch", serverProtocolVersion: PROTOCOL_VERSION };
}
