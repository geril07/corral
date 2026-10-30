import { createRootRoute, Outlet } from "@tanstack/react-router";
import { ConnectionNotice, useConnection } from "../modules/connection/index.ts";

export const Route = createRootRoute({ component: Root });

function Root() {
  const connection = useConnection();
  if (connection.status === "protocol-mismatch") return <ConnectionNotice state={connection} />;
  return <Outlet />;
}
