import { expect, test } from "vite-plus/test";
import { describeError } from "./rpc-errors.ts";
import { eventually, recordStatuses, useServer } from "../test/server-fixture.ts";

const server = useServer();

/** What the user would read when `promise` is refused. */
const described = (promise: Promise<unknown>) => promise.then(() => undefined, describeError);

test("the list starts unloaded, then follows add and remove", async () => {
  const client = server.connect();
  expect(client.projects.getSnapshot()).toEqual({ loaded: false, projects: [] });
  await eventually(() => expect(client.projects.getSnapshot().loaded).toBe(true));
  expect(client.projects.getSnapshot().projects).toEqual([]);

  const first = await client.connection.api.projects.add({ path: server.repo("first") });
  const second = await client.connection.api.projects.add({ path: server.repo("second") });
  await eventually(() => expect(client.projects.getSnapshot().projects).toEqual([first, second]));
  expect(first).toMatchObject({ name: "first", defaultBaseBranch: "main" });

  await client.connection.api.projects.remove({ id: first.id });
  await eventually(() => expect(client.projects.getSnapshot().projects).toEqual([second]));
});

test("another client sees a project added by this one", async () => {
  const adder = await server.connected();
  const watcher = server.connect();
  const project = await adder.connection.api.projects.add({ path: server.repo() });

  await eventually(() => expect(watcher.projects.getSnapshot().projects).toEqual([project]));
});

test("after the connection drops, the list catches up with what changed meanwhile", async () => {
  const proxy = await server.proxy();
  const client = await server.connected(proxy.url);
  const statuses = recordStatuses(client.connection.state);
  const before = await client.connection.api.projects.add({ path: server.repo("before") });
  await eventually(() => expect(client.projects.getSnapshot().projects).toEqual([before]));

  proxy.refuse(true);
  proxy.drop();
  await eventually(() => expect(statuses).toContain("disconnected"));
  expect(client.projects.getSnapshot().projects).toEqual([before]);

  const other = await server.connected();
  const during = await other.connection.api.projects.add({ path: server.repo("during") });
  await other.connection.api.projects.remove({ id: before.id });
  proxy.refuse(false);

  await eventually(() => expect(client.projects.getSnapshot().projects).toEqual([during]));
});

test("the server's refusals read as sentences", async () => {
  const { api } = await server.connected().then((client) => client.connection);
  const repo = server.repo();
  await api.projects.add({ path: repo });

  expect(await described(api.projects.add({ path: repo }))).toBe(
    "This repository is already added.",
  );
  expect(await described(api.projects.add({ path: "/" }))).toBe(
    "/ is not inside a git repository.",
  );
});
