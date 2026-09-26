import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { afterEach } from "vitest";
import { openDatabase } from "../src/db/open.js";

// Everything made here is closed and removed after each test in the file that uses it.
const openDbs: Database[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "linkling-db-"));
  dirs.push(dir);
  return dir;
}

/** A fresh database file, not :memory:, which cannot run in WAL mode. */
export function openTempDatabase(): Database {
  const db = openDatabase(join(tempDir(), "linkling.db"));
  openDbs.push(db);
  return db;
}
