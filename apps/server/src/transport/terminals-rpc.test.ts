import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { sh } from "../../test/programs.ts";
import { useServer, within } from "../../test/server-fixture.ts";

const server = useServer();

let workDir: string;
beforeEach(async () => {
  workDir = await realpath(await mkdtemp(join(tmpdir(), "corral-rpc-")));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(workDir, { recursive: true, force: true });
});

test("create runs the command in the given cwd with the server env plus the given env and TERM", async () => {
  vi.stubEnv("CORRAL_FROM_SERVER", "server-value");
  const info = await server.createTerminal(
    sh('echo "$CORRAL_FROM_SERVER $CORRAL_GIVEN $TERM"; pwd; read x'),
    { cwd: workDir, env: { CORRAL_GIVEN: "given-value", TERM: "dumb" } },
  );
  expect(info).toMatchObject({
    command: "/bin/sh",
    cwd: workDir,
    size: { cols: 80, rows: 24 },
    exit: null,
  });

  const client = await server.attach(info.id);
  await client.waitForScreen("server-value given-value xterm-256color");
  await client.waitForScreen(workDir);
});

test("create without a command runs $SHELL in the home directory", async () => {
  vi.stubEnv("SHELL", "/bin/sh");
  const info = await server.createTerminal();

  expect(info).toMatchObject({ command: "/bin/sh", args: [], cwd: homedir() });
});

test("a command that cannot start gives a terminal that exits with its error on screen", async () => {
  const info = await server.createTerminal({ command: "/no/such/command", args: [] });
  const client = await server.attach(info.id);

  await client.waitForScreen("No such file or directory");
  expect((await client.waitForClose()).code).toBe(1000);
  expect((await (await server.rpc()).terminals.list())[0]!.exit).toEqual({ exitCode: 1 });
});

test("list returns every terminal, exited ones included, until they are closed", async () => {
  const api = await server.rpc();
  const running = await server.createTerminal(sh("read x"));
  const exiting = await server.createTerminal(sh("exit 5"));
  const client = await server.attach(exiting.id);
  await client.waitForClose();

  const listed = await api.terminals.list();
  expect(listed.map((terminal) => terminal.id)).toEqual([running.id, exiting.id]);
  expect(listed[1]!.exit).toEqual({ exitCode: 5 });

  await api.terminals.close({ id: exiting.id });
  expect((await api.terminals.list()).map((terminal) => terminal.id)).toEqual([running.id]);
});

test("close of an unknown id fails with a typed NOT_FOUND", async () => {
  const api = await server.rpc();

  await expect(api.terminals.close({ id: "missing" })).rejects.toMatchObject({
    code: "NOT_FOUND",
    data: { id: "missing" },
  });
});

test("close kills the process", async () => {
  const api = await server.rpc();
  const pidFile = join(workDir, "pid");
  const info = await server.createTerminal(sh(`echo $$ > ${pidFile}; echo started; sleep 600`));
  const client = await server.attach(info.id);
  await client.waitForScreen("started");
  const pid = Number(await readFile(pidFile, "utf8"));

  await api.terminals.close({ id: info.id });

  await expect
    .poll(() => processExists(pid), { timeout: 10_000, message: "process exits after close" })
    .toBe(false);
});

test("watch yields the list at once and again after create, resize, exit and close", async () => {
  const api = await server.rpc();
  const updates = await api.terminals.watch();
  const next = async () => (await within(updates.next(), "a watch update")).value;

  expect(await next()).toEqual([]);

  const info = await server.createTerminal(sh("read x; exit 4"));
  expect(await next()).toEqual([info]);

  const client = await server.attach(info.id);
  client.resize({ cols: 100, rows: 30 });
  expect(await next()).toEqual([{ ...info, size: { cols: 100, rows: 30 } }]);

  client.type("\n");
  expect(await next()).toEqual([{ ...info, size: { cols: 100, rows: 30 }, exit: { exitCode: 4 } }]);

  await api.terminals.close({ id: info.id });
  expect(await next()).toEqual([]);
  await updates.return?.();
});

test("a loose terminal keeps its label on every client and through a client reconnect, without restarting", async () => {
  const pidFile = join(workDir, "pid");
  const info = await server.createTerminal(sh(`echo $$ > ${pidFile}; echo started; read x`));
  const stream = await server.attach(info.id);
  await stream.waitForScreen("started");
  const pid = Number(await readFile(pidFile, "utf8"));
  const api = await server.rpc();
  const otherApi = await server.rpc();
  const updates = await api.terminals.watch();
  const otherUpdates = await otherApi.terminals.watch();
  await within(updates.next(), "the terminals");
  await within(otherUpdates.next(), "the terminals on the second client");

  const renamed = await api.terminals.setLabel({ id: info.id, label: "  api logs  " });

  expect(renamed).toMatchObject({ id: info.id, label: "api logs", command: info.command });
  const labeled = [{ ...info, label: "api logs" }];
  expect((await within(updates.next(), "the label")).value).toEqual(labeled);
  expect((await within(otherUpdates.next(), "the label")).value).toEqual(labeled);
  expect(await otherApi.terminals.list()).toEqual(labeled);
  expect(processExists(pid)).toBe(true);

  // A client that connects again sees the same terminal, label and all; only a server restart
  // ends a loose terminal (decision 12) and with it the label.
  const reconnected = await server.rpc();
  expect(await reconnected.terminals.list()).toEqual(labeled);
  expect(processExists(pid)).toBe(true);

  expect(await reconnected.terminals.setLabel({ id: info.id, label: "   " })).toMatchObject({
    label: null,
  });
  expect((await reconnected.terminals.list())[0]!.label).toBeNull();

  await expect(reconnected.terminals.setLabel({ id: "missing", label: "x" })).rejects.toMatchObject(
    { code: "NOT_FOUND", data: { id: "missing" } },
  );
  await updates.return?.();
  await otherUpdates.return?.();
});

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
