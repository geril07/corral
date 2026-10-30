import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import { MIGRATIONS, migrate, openDatabase, schemaVersion } from "./database.ts";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "corral-db-"));
});
afterEach(() => rm(dataDir, { recursive: true, force: true }));

test("a new database gets every migration and survives being opened again with its data", () => {
  const first = openDatabase(join(dataDir, "nested", "data"));
  expect(schemaVersion(first)).toBe(MIGRATIONS.length);
  first.exec(
    "INSERT INTO projects (id, name, path, default_base_branch) VALUES ('p', 'n', '/n', 'main')",
  );
  first.close();

  const second = openDatabase(join(dataDir, "nested", "data"));
  expect(second.prepare("SELECT id FROM projects").all()).toEqual([{ id: "p" }]);
  expect(schemaVersion(second)).toBe(MIGRATIONS.length);
  second.close();
});

test("only the migrations not yet applied run", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, ["CREATE TABLE a (x)"]);
  migrate(db, ["CREATE TABLE a (x)", "CREATE TABLE b (y)"]);

  expect(schemaVersion(db)).toBe(2);
  expect(
    db.prepare("SELECT name FROM sqlite_master WHERE name IN ('a','b') ORDER BY name").all(),
  ).toEqual([{ name: "a" }, { name: "b" }]);
});

test("a failing migration changes nothing and leaves the version where it was", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, ["CREATE TABLE a (x)"]);

  expect(() =>
    migrate(db, ["CREATE TABLE a (x)", "CREATE TABLE b (y); INSERT INTO missing VALUES (1)"]),
  ).toThrow(/no such table/);

  expect(schemaVersion(db)).toBe(1);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").all()).toEqual([]);
});

test("a database from a newer server is refused", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);

  expect(() => migrate(db, MIGRATIONS)).toThrow(/newer/);
});
