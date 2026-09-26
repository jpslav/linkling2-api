import { copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { expect, test } from "vitest";
import { MIGRATIONS_DIR, migrate } from "../src/db/migrate.js";
import { openTempDatabase, tempDir } from "./temp-db.js";

function tableNames(db: BetterSqlite3.Database): string[] {
  return db
    .prepare<[], { name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
}

test("opening runs the migrations once and leaves exactly ADR-0003's tables", () => {
  const db = openTempDatabase();
  expect(db.pragma("user_version", { simple: true })).toBe(1);
  // sqlite_sequence is SQLite's own, created because links.id is AUTOINCREMENT.
  expect(tableNames(db)).toEqual(["daily_counts", "links", "sqlite_sequence"]);
  expect(migrate(db)).toEqual([]);
  expect(db.pragma("user_version", { simple: true })).toBe(1);
  expect(tableNames(db)).toEqual(["daily_counts", "links", "sqlite_sequence"]);
});

test("the links table is ADR-0003's, column for column", () => {
  const db = openTempDatabase();
  expect(
    db.prepare("SELECT name, type, \"notnull\", pk FROM pragma_table_info('links') ORDER BY cid").all(),
  ).toEqual([
    { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "name", type: "TEXT", notnull: 1, pk: 0 },
    { name: "target", type: "TEXT", notnull: 1, pk: 0 },
    { name: "made_by", type: "TEXT", notnull: 1, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "expires_at", type: "TEXT", notnull: 0, pk: 0 },
  ]);
});

test("the database runs in WAL mode", () => {
  const db = openTempDatabase();
  expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
});

test("a gap in the migration numbers is refused before anything runs", () => {
  const dir = tempDir();
  copyFileSync(join(MIGRATIONS_DIR, "0001_links_and_daily_counts.sql"), join(dir, "0001_links_and_daily_counts.sql"));
  writeFileSync(join(dir, "0003_skipped_two.sql"), "CREATE TABLE never (x);");
  const db = new BetterSqlite3(":memory:");
  expect(() => migrate(db, dir)).toThrow(/no gap or repeat/);
  expect(db.pragma("user_version", { simple: true })).toBe(0);
  expect(tableNames(db)).toEqual([]);
});

test("a database from newer code is refused, not downgraded", () => {
  const db = new BetterSqlite3(":memory:");
  db.pragma("user_version = 2");
  expect(() => migrate(db)).toThrow(/at migration 2 but this code knows only 0 to 1/);
});

test("a negative user_version is refused rather than read as counting from the end", () => {
  const db = new BetterSqlite3(":memory:");
  db.pragma("user_version = -1");
  expect(() => migrate(db)).toThrow(/at migration -1/);
  expect(tableNames(db)).toEqual([]);
});

test("a .sql file that is not named NNNN_<what>.sql is refused, not skipped", () => {
  for (const misnamed of ["002_short.sql", "0002-dash.sql"]) {
    const dir = tempDir();
    copyFileSync(join(MIGRATIONS_DIR, "0001_links_and_daily_counts.sql"), join(dir, "0001_links_and_daily_counts.sql"));
    writeFileSync(join(dir, misnamed), "CREATE TABLE extra (x);");
    const db = new BetterSqlite3(":memory:");
    expect(() => migrate(db, dir)).toThrow(/would never run/);
    expect(tableNames(db)).toEqual([]);
  }
});

test("two migrations with the same number are refused", () => {
  const dir = tempDir();
  copyFileSync(join(MIGRATIONS_DIR, "0001_links_and_daily_counts.sql"), join(dir, "0001_links_and_daily_counts.sql"));
  writeFileSync(join(dir, "0001_again.sql"), "CREATE TABLE extra (x);");
  const db = new BetterSqlite3(":memory:");
  expect(() => migrate(db, dir)).toThrow(/no gap or repeat/);
  expect(tableNames(db)).toEqual([]);
});

test("a migration that fails leaves the database at the version before it", () => {
  const dir = tempDir();
  copyFileSync(join(MIGRATIONS_DIR, "0001_links_and_daily_counts.sql"), join(dir, "0001_links_and_daily_counts.sql"));
  writeFileSync(join(dir, "0002_broken.sql"), "CREATE TABLE half (x); THIS IS NOT SQL;");
  const db = new BetterSqlite3(":memory:");
  expect(() => migrate(db, dir)).toThrow();
  expect(db.pragma("user_version", { simple: true })).toBe(1);
  expect(tableNames(db)).toEqual(["daily_counts", "links", "sqlite_sequence"]);
});
