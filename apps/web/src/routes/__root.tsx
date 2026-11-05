import { createRootRoute, Outlet } from "@tanstack/react-router";
import { ProtocolMismatchNotice, useConnection } from "../modules/connection/index.ts";

export const Route = createRootRoute({ component: Root });

function Root() {
  const connection = useConnection();
  if (connection.status === "protocol-mismatch") {
    return <ProtocolMismatchNotice serverProtocolVersion={connection.serverProtocolVersion} />;
  }
  return <Outlet />;
}
