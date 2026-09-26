import { copyFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import BetterSqlite3 from "better-sqlite3";
import { expect, test } from "vitest";
import { MIGRATIONS_DIR, migrate } from "../src/db/migrate.js";
import { openDatabase } from "../src/db/open.js";
import { openTempDatabase, tempDir } from "./temp-db.js";

function tableNames(db: BetterSqlite3.Database): string[] {
  return db
    .prepare<[], { name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
}

// The number of the last file in migrations/.
const LATEST = 2;

test("opening runs the migrations once and leaves exactly ADR-0003's tables", () => {
  const db = openTempDatabase();
  expect(db.pragma("user_version", { simple: true })).toBe(LATEST);
  // sqlite_sequence is SQLite's own, created because links.id is AUTOINCREMENT.
  expect(tableNames(db)).toEqual(["daily_counts", "links", "sqlite_sequence"]);
  expect(migrate(db)).toEqual([]);
  expect(db.pragma("user_version", { simple: true })).toBe(LATEST);
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

test("opening a fresh file another connection has locked waits for the lock, then turns WAL on", async () => {
  const path = join(tempDir(), "linkling.db");
  // Another connection holds the write lock on the new file for 300ms: the moment in
  // which a second process starting at once would get SQLITE_BUSY switching to WAL.
  const holder = new Worker(
    `const { workerData, parentPort } = require("node:worker_threads");
     const Database = require(workerData.driver);
     const db = new Database(workerData.path);
     db.exec("BEGIN IMMEDIATE; CREATE TABLE lock_holder (x);");
     parentPort.postMessage("locked");
     Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
     db.exec("ROLLBACK");
     db.close();`,
    { eval: true, workerData: { path, driver: createRequire(import.meta.url).resolve("better-sqlite3") } },
  );
  await new Promise((resolve) => holder.once("message", resolve));
  const db = openDatabase(path);
  try {
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST);
  } finally {
    db.close();
    await holder.terminate();
  }
});

// ADR-0014: a rowid is handed out in insertion order, which would record the order links
// were first counted in. Migration 0002 rebuilds the table without one and keeps its rows.
test("daily_counts has no rowid, and migration 0002 keeps the counts already there", () => {
  const dir = tempDir();
  copyFileSync(join(MIGRATIONS_DIR, "0001_links_and_daily_counts.sql"), join(dir, "0001_links_and_daily_counts.sql"));
  const db = new BetterSqlite3(join(dir, "linkling.db"));
  try {
    expect(migrate(db, dir)).toEqual([1]);
    db.exec("INSERT INTO daily_counts VALUES (7, '2026-09-26', 3), (2, '2026-09-25', 1)");
    // Blind arm: before 0002 the table has a rowid, so the check below can tell.
    expect(db.prepare("SELECT rowid, link_id FROM daily_counts ORDER BY rowid").all()).toEqual([
      { rowid: 1, link_id: 7 },
      { rowid: 2, link_id: 2 },
    ]);

    expect(migrate(db)).toEqual([2]);
    expect(() => db.prepare("SELECT rowid FROM daily_counts").all()).toThrow(/no such column: rowid/);
    expect(db.prepare("SELECT * FROM daily_counts ORDER BY link_id").all()).toEqual([
      { link_id: 2, day: "2026-09-25", count: 1 },
      { link_id: 7, day: "2026-09-26", count: 3 },
    ]);
    expect(tableNames(db)).toEqual(["daily_counts", "links", "sqlite_sequence"]);
  } finally {
    db.close();
  }
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
  db.pragma(`user_version = ${LATEST + 1}`);
  expect(() => migrate(db)).toThrow(`at migration ${LATEST + 1} but this code knows only 0 to ${LATEST}`);
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

test("files that do not start with a digit, such as macOS ._ sidecars, are not migrations", () => {
  const dir = tempDir();
  copyFileSync(join(MIGRATIONS_DIR, "0001_links_and_daily_counts.sql"), join(dir, "0001_links_and_daily_counts.sql"));
  writeFileSync(join(dir, "._0001_links_and_daily_counts.sql"), "");
  writeFileSync(join(dir, "README.md"), "notes");
  const db = new BetterSqlite3(":memory:");
  expect(migrate(db, dir)).toEqual([1]);
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
